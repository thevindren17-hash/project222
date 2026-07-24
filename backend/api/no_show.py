"""
Auto-complete Scheduler
Runs hourly via APScheduler.

Race-condition safety: same atomic-claim pattern as reminders.py — an
UPDATE ... WHERE auto_completed = false RETURNING * claims rows first, so
only one instance wins each row across multi-instance Railway deployments.

Bookings still 'pending'/'confirmed' more than 2 hours after their
scheduled_at are assumed attended and flipped to 'completed'. Staff can
override a wrongly auto-completed booking with "Mark No-Show" in the
dashboard (booking-detail-modal.tsx).
"""

import logging
from datetime import timedelta

from shared.tenant_config import get_supabase_client, _db
from shared.scheduler_lock import acquire_lock
from shared.utils import now_local, to_db_timestamp

logger = logging.getLogger(__name__)


async def auto_complete_bookings():
    """Flip past-due pending/confirmed bookings to 'completed'."""
    if not await acquire_lock("auto_complete_bookings", duration_minutes=50):
        logger.info("Auto-complete: lock held by another instance, skipping this run")
        return
    supabase = get_supabase_client()
    # scheduled_at holds the clinic's LOCAL wall-clock digits (never UTC) --
    # comparing it against the server's own (usually UTC) clock silently
    # shifted this cutoff by the clinic's UTC offset, the same class of bug
    # that once sent reminders hours late (see shared/utils.py).
    cutoff = to_db_timestamp(now_local() - timedelta(hours=2))

    try:
        claimed = await _db(lambda: supabase.table("bookings").update({
            "status": "completed",
            "auto_completed": True,
        }).in_(
            "status", ["pending", "confirmed"]
        ).lt("scheduled_at", cutoff).eq("auto_completed", False).execute())

        logger.info(f"Auto-complete: transitioned {len(claimed.data or [])} bookings to completed")
    except Exception as e:
        logger.error(f"Auto-complete bookings failed: {e}", exc_info=True)
