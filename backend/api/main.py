"""
FastAPI Server
Handles WhatsApp webhooks, Google OAuth callbacks, and health checks.
"""

import os
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime

import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.asyncio import AsyncioIntegration
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

if os.getenv("SENTRY_DSN"):
    sentry_sdk.init(
        dsn=os.getenv("SENTRY_DSN"),
        integrations=[FastApiIntegration(), AsyncioIntegration()],
        traces_sample_rate=0.05,
        environment=os.getenv("RAILWAY_ENVIRONMENT", "production"),
    )

from api.whatsapp import router as whatsapp_router
from api.integrations import router as integrations_router
from api.agent import router as agent_router
from api.reminders import scheduler, send_appointment_reminders
from api.campaigns import send_feedback_requests, send_recall_messages, cleanup_expired_campaigns


@asynccontextmanager
async def lifespan(app: FastAPI):
    scheduler.add_job(
        send_appointment_reminders,
        "interval",
        minutes=30,
        next_run_time=datetime.now(),
        id="appointment_reminders",
        replace_existing=True,
    )
    scheduler.add_job(
        send_feedback_requests,
        "interval",
        minutes=30,
        next_run_time=datetime.now(),
        id="feedback_requests",
        replace_existing=True,
    )
    scheduler.add_job(
        send_recall_messages,
        "interval",
        hours=24,
        next_run_time=datetime.now(),
        id="recall_messages",
        replace_existing=True,
    )
    scheduler.add_job(
        cleanup_expired_campaigns,
        "interval",
        hours=6,
        next_run_time=datetime.now(),
        id="campaign_cleanup",
        replace_existing=True,
    )
    scheduler.start()
    yield
    scheduler.shutdown(wait=True)


app = FastAPI(title="AI Receptionist Backend", version="1.0.0", lifespan=lifespan)

_origins = [o for o in [
    os.getenv("FRONTEND_URL", "").strip().rstrip("/"),
    "http://localhost:3000",
] if o]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["POST", "GET", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Internal-Secret"],
)

app.include_router(whatsapp_router, prefix="/webhook", tags=["WhatsApp"])
app.include_router(integrations_router, prefix="/api/integrations", tags=["Integrations"])
app.include_router(agent_router, prefix="/api/agent", tags=["Agent"])


@app.get("/")
async def root():
    return {"status": "ok", "service": "ai-receptionist-backend"}


@app.get("/health")
async def health():
    return {"status": "healthy", "timestamp": datetime.now().isoformat()}


# ── Manual job trigger (for testing) ─────────────────────────────────────────
# Protected by TRIGGER_SECRET env var + rate limited to 10 calls/minute.

_JOBS = {
    "reminders": send_appointment_reminders,
    "feedback":  send_feedback_requests,
    "recall":    send_recall_messages,
    "cleanup":   cleanup_expired_campaigns,
}

_trigger_calls: dict = defaultdict(lambda: deque(maxlen=20))

def _trigger_rate_limited(secret_key: str) -> bool:
    now = time.monotonic()
    q = _trigger_calls[secret_key]
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= 10:
        return True
    q.append(now)
    return False

@app.post("/admin/trigger/{job}")
async def trigger_job(job: str, x_trigger_secret: str = Header(default="")):
    secret = os.getenv("TRIGGER_SECRET", "")
    if not secret or x_trigger_secret != secret:
        raise HTTPException(status_code=403, detail="Invalid or missing X-Trigger-Secret header")
    if _trigger_rate_limited(secret):
        raise HTTPException(status_code=429, detail="Rate limit: max 10 trigger calls per minute")
    if job not in _JOBS:
        raise HTTPException(status_code=404, detail=f"Unknown job '{job}'. Valid: {list(_JOBS)}")
    await _JOBS[job]()
    return {"status": "ok", "job": job, "ran_at": datetime.now().isoformat()}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8000)))
