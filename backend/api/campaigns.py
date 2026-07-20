"""
Patient Lifecycle Campaigns — Phase 1: Post-Visit Feedback & Google Reviews

Flow:
  1. Scheduler runs every 30 min.
  2. Finds bookings 2–6 h past their scheduled time (not cancelled, no feedback sent yet).
  3. Sends: "How was your visit? Rate 1–5."
  4. When patient replies with a digit 1–5:
       4–5 → send Google review link (if configured) → status = review_sent
       1–3 → create escalation alert for staff         → status = escalated
"""

import logging
import re
from datetime import datetime, timedelta
from typing import Optional

from shared.tenant_config import get_supabase_client, _db, _db_optional
from shared.scheduler_lock import acquire_lock

logger = logging.getLogger(__name__)

# ── Default message templates ─────────────────────────────────────────────────

DEFAULT_FEEDBACK_MSG = (
    "Hi {name}! 😊 Thank you for visiting us today for your {service}. "
    "How was your experience? Please reply with a number:\n"
    "1 ⭐ – Poor\n2 ⭐⭐ – Fair\n3 ⭐⭐⭐ – Good\n4 ⭐⭐⭐⭐ – Great\n5 ⭐⭐⭐⭐⭐ – Excellent"
)

DEFAULT_REVIEW_MSG = (
    "Thank you for the {rating} stars! ⭐ We really appreciate it. "
    "Would you mind sharing your experience on Google? It helps us a lot:\n{review_link}"
)

DEFAULT_NEGATIVE_MSG = (
    "We're sorry to hear that, {name}. We take all feedback seriously "
    "and our team will reach out to you shortly to make things right. 🙏"
)

# ── Rating extractor ──────────────────────────────────────────────────────────

def extract_rating(text: str) -> Optional[int]:
    """Return 1-5 if the message looks like a rating, else None."""
    text = text.strip()
    if len(text) > 20:          # too long to be just a rating
        return None
    m = re.search(r'\b([1-5])\b', text)
    if m:
        return int(m.group(1))
    stars = text.count('⭐')    # count star emojis
    if 1 <= stars <= 5:
        return stars
    return None


# ── Scheduler job ─────────────────────────────────────────────────────────────

async def send_feedback_requests():
    """
    Find completed (or past-due) appointments in the 2–6 h window
    that haven't received a feedback message yet, and send one.
    """
    if not await acquire_lock("feedback_requests", duration_minutes=25):
        logger.info("Feedback: lock held by another instance, skipping this run")
        return
    supabase = get_supabase_client()
    now = datetime.now()
    window_start = (now - timedelta(hours=6)).isoformat()
    window_end   = (now - timedelta(hours=2)).isoformat()

    # Load all tenants with feedback enabled + WA credentials
    settings_res = await _db(lambda: supabase.table("tenant_settings").select(
        "tenant_id, feedback_enabled, google_review_url, "
        "feedback_message_template, review_request_template, negative_feedback_message"
    ).eq("feedback_enabled", True).execute())

    for settings in (settings_res.data or []):
        tenant_id = settings["tenant_id"]

        tenant_res = await _db_optional(lambda: supabase.table("tenants").select(
            "wa_phone_number_id, wa_access_token"
        ).eq("id", tenant_id).eq("is_active", True).maybe_single().execute())

        if not tenant_res.data:
            continue
        phone_number_id = tenant_res.data.get("wa_phone_number_id")
        access_token    = tenant_res.data.get("wa_access_token")
        if not phone_number_id or not access_token:
            continue

        # Bookings in the 2–6 h window (not cancelled)
        bookings_res = await _db(lambda: supabase.table("bookings").select(
            "id, contact_id, service_type, scheduled_at"
        ).eq("tenant_id", tenant_id).not_.in_(
            "status", ["cancelled"]
        ).gte("scheduled_at", window_start).lte("scheduled_at", window_end).execute())

        if not bookings_res.data:
            continue

        # Exclude bookings that already have a feedback campaign
        booking_ids = [b["id"] for b in bookings_res.data]
        existing_res = await _db(lambda: supabase.table("campaigns").select(
            "booking_id"
        ).eq("tenant_id", tenant_id).eq("type", "feedback").in_(
            "booking_id", booking_ids
        ).execute())
        already_sent = {c["booking_id"] for c in (existing_res.data or [])}

        for booking in bookings_res.data:
            if booking["id"] in already_sent:
                continue

            contact_id = booking.get("contact_id")
            if not contact_id:
                continue

            _cid = contact_id
            contact_res = await _db_optional(lambda: supabase.table("contacts").select(
                "name, phone"
            ).eq("id", _cid).eq("opted_out", False).maybe_single().execute())
            if not contact_res.data:
                continue

            contact = contact_res.data
            phone   = contact.get("phone", "")
            if not phone:
                continue

            name    = contact.get("name") or "there"
            service = booking.get("service_type", "appointment")

            tmpl    = settings.get("feedback_message_template") or DEFAULT_FEEDBACK_MSG
            message = tmpl.replace("{name}", name).replace("{service}", service)

            try:
                await _send_wa(phone, message, phone_number_id, access_token)

                # Find existing thread (for saving message history)
                thread_res = await _db(lambda: supabase.table("whatsapp_threads").select("id").eq(
                    "tenant_id", tenant_id
                ).eq("contact_number", phone).order("created_at", desc=True).limit(1).execute())
                thread_id = thread_res.data[0]["id"] if thread_res.data else None

                _bid = booking["id"]
                await _db(lambda: supabase.table("campaigns").insert({
                    "tenant_id":  tenant_id,
                    "contact_id": contact_id,
                    "booking_id": _bid,
                    "thread_id":  thread_id,
                    "type":       "feedback",
                    "status":     "sent",
                    "sent_at":    datetime.now().isoformat(),
                }).execute())

                if thread_id:
                    _tid = thread_id
                    await _db(lambda: supabase.table("messages").insert({
                        "thread_id":  _tid,
                        "tenant_id":  tenant_id,
                        "contact_id": contact_id,
                        "role":       "assistant",
                        "body":       message,
                        "handled_by": "ai",
                    }).execute())
                    await _db(lambda: supabase.table("whatsapp_threads").update({
                        "last_message_at": datetime.now().isoformat()
                    }).eq("id", _tid).execute())

                logger.info(f"Feedback sent | tenant={tenant_id} | booking={booking['id']}")

            except Exception as e:
                logger.error(f"Feedback send failed | tenant={tenant_id} | booking={booking['id']} | {e}")


# ── Feedback response handler (called from whatsapp.py) ──────────────────────

async def get_pending_feedback_campaign(
    tenant_id: str,
    contact_id: str,
) -> Optional[dict]:
    """
    Return the most recent 'sent' feedback campaign for this contact
    if it was sent within the last 12 hours, else None.
    """
    supabase = get_supabase_client()
    cutoff = (datetime.now() - timedelta(hours=12)).isoformat()

    res = await _db_optional(lambda: supabase.table("campaigns").select("*").eq(
        "tenant_id", tenant_id
    ).eq("contact_id", contact_id).eq("type", "feedback").eq(
        "status", "sent"
    ).gte("sent_at", cutoff).order("sent_at", desc=True).limit(1).maybe_single().execute())

    return res.data or None


async def handle_feedback_response(
    tenant,
    contact: dict,
    thread: dict,
    from_number: str,
    campaign: dict,
    rating: int,
    message_text: str,
    language: str,
):
    """
    Process a 1–5 rating reply:
    - 4–5: thank + send Google review link
    - 1–3: thank + alert staff (escalation)
    Updates the campaign record and saves messages to thread.
    """
    from api.whatsapp import send_whatsapp_message
    supabase  = get_supabase_client()
    tenant_id = tenant.tenant_id
    thread_id = thread["id"]
    contact_id = contact.get("id")
    campaign_id = campaign["id"]

    # Load tenant's feedback settings
    settings_res = await _db_optional(lambda: supabase.table("tenant_settings").select(
        "google_review_url, review_request_template, negative_feedback_message"
    ).eq("tenant_id", tenant_id).maybe_single().execute())
    settings = settings_res.data or {}

    google_review_url = settings.get("google_review_url", "")
    name = contact.get("name") or "there"

    # Save patient's rating message
    await _db(lambda: supabase.table("messages").insert({
        "thread_id":  thread_id,
        "tenant_id":  tenant_id,
        "contact_id": contact_id,
        "role":       "user",
        "body":       message_text,
        "handled_by": "ai",
    }).execute())

    if rating >= 4:
        new_status = "review_sent" if google_review_url else "responded"

        if google_review_url:
            tmpl  = settings.get("review_request_template") or DEFAULT_REVIEW_MSG
            reply = (
                tmpl
                .replace("{name}", name)
                .replace("{rating}", str(rating))
                .replace("{review_link}", google_review_url)
            )
        else:
            # No review link configured — just thank them
            reply = f"Thank you so much for the {rating} stars, {name}! We really appreciate your feedback. 😊"

        try:
            await send_whatsapp_message(
                to=from_number,
                text=reply,
                phone_number_id=tenant.wa_phone_number_id,
                access_token=tenant.wa_access_token,
            )
            await _db(lambda: supabase.table("messages").insert({
                "thread_id":  thread_id,
                "tenant_id":  tenant_id,
                "contact_id": contact_id,
                "role":       "assistant",
                "body":       reply,
                "handled_by": "ai",
            }).execute())
        except Exception as e:
            logger.error(f"Review request send failed: {e}")

    else:
        # Low rating — apologise + alert staff
        new_status = "escalated"
        tmpl  = settings.get("negative_feedback_message") or DEFAULT_NEGATIVE_MSG
        reply = tmpl.replace("{name}", name).replace("{rating}", str(rating))

        try:
            await send_whatsapp_message(
                to=from_number,
                text=reply,
                phone_number_id=tenant.wa_phone_number_id,
                access_token=tenant.wa_access_token,
            )
            await _db(lambda: supabase.table("messages").insert({
                "thread_id":  thread_id,
                "tenant_id":  tenant_id,
                "contact_id": contact_id,
                "role":       "assistant",
                "body":       reply,
                "handled_by": "ai",
            }).execute())
        except Exception as e:
            logger.error(f"Negative feedback reply failed: {e}")

        # Create escalation record so staff can see it in dashboard
        await _db(lambda: supabase.table("escalations").insert({
            "tenant_id": tenant_id,
            "reason":    "negative_feedback",
            "context":   f"Patient rated {rating}/5. Message: {message_text}",
            "source":    "whatsapp",
            "created_at": datetime.now().isoformat(),
        }).execute())

        logger.warning(
            f"Negative feedback | rating={rating} | tenant={tenant_id} | contact={contact_id}"
        )

    # Update campaign record
    _cid = campaign_id
    await _db(lambda: supabase.table("campaigns").update({
        "status":       new_status,
        "responded_at": datetime.now().isoformat(),
        "response_text": message_text,
        "rating":        rating,
    }).eq("id", _cid).execute())

    # Update thread timestamp
    await _db(lambda: supabase.table("whatsapp_threads").update({
        "last_message_at": datetime.now().isoformat()
    }).eq("id", thread_id).execute())

    logger.info(
        f"Feedback handled | rating={rating} | status={new_status} | tenant={tenant_id}"
    )


# ── Phase 2: Patient Recall & Re-engagement ───────────────────────────────────

DEFAULT_RECALL_MSG = (
    "Hi {name}! 👋 It's been a while since your last visit at {clinic}. "
    "We'd love to see you again! Just reply to book your next appointment "
    "and we'll get you sorted right away. 😊"
)


async def send_recall_messages():
    """
    Daily job: find patients who haven't visited in X months and haven't
    already been contacted for recall, then send a re-engagement message.
    Capped at 50 contacts per tenant per run to avoid bulk-send limits.
    """
    if not await acquire_lock("recall_messages", duration_minutes=60):
        logger.info("Recall: lock held by another instance, skipping this run")
        return
    supabase = get_supabase_client()
    now = datetime.now()

    settings_res = await _db(lambda: supabase.table("tenant_settings").select(
        "tenant_id, recall_interval_months, recall_message_template"
    ).eq("recall_enabled", True).execute())

    for settings in (settings_res.data or []):
        tenant_id = settings["tenant_id"]
        months = settings.get("recall_interval_months") or 6
        cutoff = (now - timedelta(days=months * 30)).isoformat()

        _tid = tenant_id
        tenant_res = await _db_optional(lambda: supabase.table("tenants").select(
            "name, wa_phone_number_id, wa_access_token"
        ).eq("id", _tid).eq("is_active", True).maybe_single().execute())
        if not tenant_res.data:
            continue

        clinic_name    = tenant_res.data.get("name", "our clinic")
        phone_number_id = tenant_res.data.get("wa_phone_number_id")
        access_token    = tenant_res.data.get("wa_access_token")
        if not phone_number_id or not access_token:
            continue

        # Contacts with ANY booking inside the recall window → still active, skip
        _tid2 = tenant_id
        _cut  = cutoff
        recent_res = await _db(lambda: supabase.table("bookings").select(
            "contact_id"
        ).eq("tenant_id", _tid2).not_.in_(
            "status", ["cancelled"]
        ).gte("scheduled_at", _cut).execute())
        recent_ids = {b["contact_id"] for b in (recent_res.data or []) if b.get("contact_id")}

        # All contacts who ever booked with this tenant
        _tid3 = tenant_id
        all_res = await _db(lambda: supabase.table("bookings").select(
            "contact_id"
        ).eq("tenant_id", _tid3).not_.in_("status", ["cancelled"]).execute())
        all_ids = {b["contact_id"] for b in (all_res.data or []) if b.get("contact_id")}

        dormant_ids = all_ids - recent_ids
        if not dormant_ids:
            continue

        # Contacts already sent a recall in the window (don't double-up)
        _tid4 = tenant_id
        _cut2 = cutoff
        existing_res = await _db(lambda: supabase.table("campaigns").select(
            "contact_id"
        ).eq("tenant_id", _tid4).eq("type", "recall").gte("sent_at", _cut2).execute())
        already_recalled = {c["contact_id"] for c in (existing_res.data or [])}

        to_contact = list(dormant_ids - already_recalled)[:50]
        if not to_contact:
            continue

        tmpl = settings.get("recall_message_template") or DEFAULT_RECALL_MSG

        for contact_id in to_contact:
            _cid = contact_id
            contact_res = await _db_optional(lambda: supabase.table("contacts").select(
                "name, phone"
            ).eq("id", _cid).eq("opted_out", False).maybe_single().execute())
            if not contact_res.data:
                continue

            phone = contact_res.data.get("phone", "")
            if not phone:
                continue

            name    = contact_res.data.get("name") or "there"
            message = tmpl.replace("{name}", name).replace("{clinic}", clinic_name)

            try:
                await _send_wa(phone, message, phone_number_id, access_token)

                _p = phone
                thread_res = await _db(lambda: supabase.table("whatsapp_threads").select("id").eq(
                    "tenant_id", tenant_id
                ).eq("contact_number", _p).order("created_at", desc=True).limit(1).execute())
                thread_id = thread_res.data[0]["id"] if thread_res.data else None

                _cid2 = contact_id
                _thid = thread_id
                await _db(lambda: supabase.table("campaigns").insert({
                    "tenant_id":  tenant_id,
                    "contact_id": _cid2,
                    "thread_id":  _thid,
                    "type":       "recall",
                    "status":     "sent",
                    "sent_at":    datetime.now().isoformat(),
                }).execute())

                if thread_id:
                    _thid2 = thread_id
                    _cid3  = contact_id
                    await _db(lambda: supabase.table("messages").insert({
                        "thread_id":  _thid2,
                        "tenant_id":  tenant_id,
                        "contact_id": _cid3,
                        "role":       "assistant",
                        "body":       message,
                        "handled_by": "ai",
                    }).execute())
                    _thid3 = thread_id
                    await _db(lambda: supabase.table("whatsapp_threads").update({
                        "last_message_at": datetime.now().isoformat()
                    }).eq("id", _thid3).execute())

                logger.info(f"Recall sent | tenant={tenant_id} | contact={contact_id}")

            except Exception as e:
                logger.error(f"Recall send failed | tenant={tenant_id} | contact={contact_id} | {e}")


# ── Campaign cleanup ──────────────────────────────────────────────────────────

async def cleanup_expired_campaigns():
    """
    Mark stale 'sent' campaigns as 'expired' so they don't pollute queries.
    - Feedback campaigns: expire after 24 h (reply window is 12 h)
    - Recall campaigns:   expire after 30 days
    Runs every 6 h via APScheduler.
    """
    supabase = get_supabase_client()
    now = datetime.now()

    feedback_cutoff = (now - timedelta(hours=24)).isoformat()
    recall_cutoff   = (now - timedelta(days=30)).isoformat()

    try:
        await _db(lambda: supabase.table("campaigns").update(
            {"status": "expired"}
        ).eq("type", "feedback").eq("status", "sent").lt("sent_at", feedback_cutoff).execute())

        await _db(lambda: supabase.table("campaigns").update(
            {"status": "expired"}
        ).eq("type", "recall").eq("status", "sent").lt("sent_at", recall_cutoff).execute())

        logger.info("Campaign cleanup done")
    except Exception as e:
        logger.error(f"Campaign cleanup error: {e}")


# ── Internal WA sender ────────────────────────────────────────────────────────

async def _send_wa(to: str, text: str, phone_number_id: str, access_token: str):
    import httpx
    to_digits = to.lstrip("+")
    url = f"https://graph.facebook.com/v21.0/{phone_number_id}/messages"
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            url,
            json={"messaging_product": "whatsapp", "to": to_digits,
                  "type": "text", "text": {"body": text}},
            headers={"Authorization": f"Bearer {access_token}",
                     "Content-Type": "application/json"},
        )
        r.raise_for_status()
