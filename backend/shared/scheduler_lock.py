"""
Distributed scheduler lock — prevents duplicate job runs when Railway
scales to multiple backend instances.

Each job tries to INSERT a lock row. If the row already exists (another
instance holds it), it falls back to UPDATE WHERE locked_until < now().
Only the instance that wins the UPDATE gets to run the job.

Setup: run backend/migrations/001_scheduler_locks.sql once in Supabase
SQL Editor. If the table does not exist the lock silently degrades to
single-instance behaviour (logs a warning).
"""

import logging
from datetime import datetime, timedelta, timezone

from shared.tenant_config import get_supabase_client, _db

logger = logging.getLogger(__name__)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def acquire_lock(job_name: str, duration_minutes: int) -> bool:
    """
    Try to acquire an exclusive lock for *job_name* lasting *duration_minutes*.

    Returns True  → this instance should run the job.
    Returns False → another instance already holds the lock; skip this run.
    """
    supabase  = get_supabase_client()
    now       = _utcnow()
    lock_until = (now + timedelta(minutes=duration_minutes)).isoformat()
    now_iso    = now.isoformat()

    # ── Step 1: try INSERT (succeeds on very first run) ───────────────────────
    try:
        res = await _db(lambda: supabase.table("scheduler_locks").insert({
            "job_name":    job_name,
            "locked_at":   now_iso,
            "locked_until": lock_until,
        }).execute())
        if res.data:
            return True
    except Exception:
        pass  # Row already exists — fall through to UPDATE

    # ── Step 2: claim if the existing lock has expired ────────────────────────
    try:
        _jn  = job_name
        _lu  = lock_until
        _ni  = now_iso
        res = await _db(lambda: supabase.table("scheduler_locks")
            .update({"locked_at": _ni, "locked_until": _lu})
            .eq("job_name", _jn)
            .lt("locked_until", _ni)
            .execute())
        return bool(res.data)
    except Exception as exc:
        # Table missing or network error — degrade gracefully
        logger.warning(
            f"Scheduler lock unavailable for '{job_name}': {exc}. "
            "Run backend/migrations/001_scheduler_locks.sql in Supabase SQL Editor."
        )
        return True   # single-instance fallback: proceed without lock
