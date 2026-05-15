"""
FastAPI Server
Handles WhatsApp webhooks, Google OAuth callbacks, and health checks.
"""

import os
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.whatsapp import router as whatsapp_router
from api.integrations import router as integrations_router
from api.agent import router as agent_router
from api.reminders import scheduler, send_appointment_reminders
from api.campaigns import send_feedback_requests, send_recall_messages


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
    scheduler.start()
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="AI Receptionist Backend", version="1.0.0", lifespan=lifespan)

_origins = [o for o in [
    os.getenv("FRONTEND_URL"),
    "http://localhost:3000",
] if o]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8000)))
