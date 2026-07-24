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
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Optional

from shared.tenant_config import get_supabase_client, get_tenant_by_id, _db, _db_optional
from shared.scheduler_lock import acquire_lock
from shared.whatsapp_send import send_whatsapp_template
from shared.utils import now_local, to_db_timestamp, from_db_timestamp

logger = logging.getLogger(__name__)

# ── Default message templates ─────────────────────────────────────────────────

# Mirrors the actual approved Meta template's wording — used only for the
# readable thread-history log, since the real send uses the fixed template.
DEFAULT_FEEDBACK_MSG = (
    "Hi {name},\n\n"
    "Thank you for visiting us for your {service}!\n\n"
    "We'd love to hear your feedback — please reply with a number from 1 to 5, "
    "where 5 means excellent.\n\n"
    "Reply STOP to opt out"
)

DEFAULT_REVIEW_MSG = (
    "Thank you for the {rating} stars! ⭐ We really appreciate it. "
    "Would you mind sharing your experience on Google? It helps us a lot:\n{review_link}"
)

DEFAULT_NEGATIVE_MSG = (
    "We're sorry to hear that, {name}. We take all feedback seriously "
    "and our team will reach out to you shortly to make things right. 🙏"
)

DEFAULT_REFERRAL_MSG = (
    "If you know anyone who'd benefit from visiting {clinic}, we'd love a "
    "referral! Just have them mention your name when they book. 😊"
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
    # This window is compared against bookings.scheduled_at, which holds the
    # clinic's LOCAL wall-clock digits (never UTC) -- using the server's own
    # clock here silently shifted the "2-6h after visit" window by the
    # clinic's UTC offset, sending feedback requests 8h later than intended.
    now = now_local()
    window_start = to_db_timestamp(now - timedelta(hours=6))
    window_end   = to_db_timestamp(now - timedelta(hours=2))

    # Load all tenants with feedback enabled + WA credentials
    settings_res = await _db(lambda: supabase.table("tenant_settings").select(
        "tenant_id, feedback_enabled, google_review_url, "
        "feedback_message_template, review_request_template, negative_feedback_message, "
        "feedback_whatsapp_template_id"
    ).eq("feedback_enabled", True).execute())

    # Batch-load every linked template once, up front -- clinic writes and
    # approves this themselves on the Message Templates page now, no more
    # hardcoded fallback name that's very unlikely to actually exist/be
    # approved on that clinic's own WABA.
    _feedback_tpl_ids = list({
        s["feedback_whatsapp_template_id"] for s in (settings_res.data or [])
        if s.get("feedback_whatsapp_template_id")
    })
    feedback_templates_by_id: dict = {}
    if _feedback_tpl_ids:
        _tpls_res = await _db(lambda: supabase.table("whatsapp_templates").select(
            "id, name, language, header_media_id"
        ).in_("id", _feedback_tpl_ids).eq("status", "approved").execute())
        feedback_templates_by_id = {t["id"]: t for t in (_tpls_res.data or [])}

    for settings in (settings_res.data or []):
        tenant_id = settings["tenant_id"]
        try:
            # get_tenant_by_id (not a raw table select) so wa_access_token
            # comes back decrypted -- a raw select would hand this loop
            # ciphertext instead of a usable Meta token.
            tenant = await get_tenant_by_id(tenant_id)
            if not tenant or not tenant.is_active:
                continue
            phone_number_id = tenant.wa_phone_number_id
            access_token    = tenant.wa_access_token
            if not phone_number_id or not access_token:
                continue

            wa_tmpl = feedback_templates_by_id.get(settings.get("feedback_whatsapp_template_id") or "")
            if not wa_tmpl:
                logger.info(f"Feedback requests skipped, no approved template linked | tenant={tenant_id}")
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

                # message is only used for the readable thread-history log below —
                # the actual send uses the fixed, Meta-approved template text.
                tmpl    = DEFAULT_FEEDBACK_MSG
                message = tmpl.replace("{name}", name).replace("{service}", service)
                template_name = wa_tmpl["name"]
                language_code = wa_tmpl.get("language") or "en"

                try:
                    await send_whatsapp_template(
                        to=phone,
                        template_name=template_name,
                        language_code=language_code,
                        parameters=[name, service],
                        phone_number_id=phone_number_id,
                        access_token=access_token,
                        header_image_id=wa_tmpl.get("header_media_id"),
                    )

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

        except Exception as e:
            # One tenant's bad data/DB hiccup must never abort the run for
            # every other clinic — log it and move on to the next tenant.
            logger.error(f"Feedback requests: tenant {tenant_id} failed, skipping | {e}", exc_info=True)
            continue


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


# ── Campaign-reply context (called from whatsapp.py) ──────────────────────────

async def get_pending_campaign_context(tenant_id: str, contact_id: str) -> Optional[dict]:
    """
    If this contact's most recent recall/marketing send hasn't been replied
    to yet (within the last 7 days), return its stored context (the exact
    personalized text sent) and mark it responded -- so the AI gets primed
    with "this patient is replying to a specific offer" exactly once, on
    their first reply, not on every subsequent turn of the conversation.
    Unlike get_pending_feedback_campaign(), this never short-circuits the
    LLM -- the caller still runs the normal booking conversation, just with
    extra context injected into the system prompt.
    """
    supabase = get_supabase_client()
    cutoff = (datetime.now() - timedelta(days=7)).isoformat()

    res = await _db_optional(lambda: supabase.table("campaigns").select("*").eq(
        "tenant_id", tenant_id
    ).eq("contact_id", contact_id).in_("type", ["recall", "marketing"]).eq(
        "status", "sent"
    ).is_("responded_at", "null").gte("sent_at", cutoff).order(
        "sent_at", desc=True
    ).limit(1).maybe_single().execute())

    campaign = res.data or None
    if not campaign or not campaign.get("context"):
        return None

    _cid = campaign["id"]
    await _db(lambda: supabase.table("campaigns").update({
        "responded_at": datetime.now().isoformat(),
    }).eq("id", _cid).execute())

    return campaign["context"]


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
        "google_review_url, review_request_template, negative_feedback_message, "
        "referral_enabled, referral_message_template"
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

        # Ask happy patients for a referral too — a separate try so a
        # referral-send failure never affects the review message already sent.
        if settings.get("referral_enabled"):
            ref_tmpl = settings.get("referral_message_template") or DEFAULT_REFERRAL_MSG
            ref_msg = ref_tmpl.replace("{name}", name).replace("{clinic}", tenant.name)
            try:
                await send_whatsapp_message(
                    to=from_number,
                    text=ref_msg,
                    phone_number_id=tenant.wa_phone_number_id,
                    access_token=tenant.wa_access_token,
                )
                await _db(lambda: supabase.table("messages").insert({
                    "thread_id":  thread_id,
                    "tenant_id":  tenant_id,
                    "contact_id": contact_id,
                    "role":       "assistant",
                    "body":       ref_msg,
                    "handled_by": "ai",
                }).execute())
            except Exception as e:
                logger.error(f"Referral message send failed: {e}")

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


def _match_recall_segment(service_type: str, segments: list) -> Optional[dict]:
    """
    Match a booking's free-text service_type against a tenant's recall
    segments (case-insensitive substring, since service_type has no fixed
    taxonomy — e.g. "Teeth Whitening" vs "whitening consultation" both need
    to hit a "whitening" segment). Falls back to the default segment, or
    None if the tenant has no default and nothing matched.
    """
    st = (service_type or "").lower()
    default_segment = None
    for seg in segments:
        if seg.get("is_default"):
            default_segment = seg
            continue
        seg_type = (seg.get("service_type") or "").lower().strip()
        if seg_type and seg_type in st:
            return seg
    return default_segment


async def send_recall_messages():
    """
    Daily job: find patients who haven't visited in X months — where X is
    the interval of whichever recall_segments row matches their most recent
    booking's service_type — and haven't already been recalled within that
    segment's window, then send a re-engagement message.
    Capped at 50 contacts per tenant per run (across all segments combined)
    to avoid bulk-send limits.
    """
    if not await acquire_lock("recall_messages", duration_minutes=60):
        logger.info("Recall: lock held by another instance, skipping this run")
        return
    supabase = get_supabase_client()
    now = datetime.now()  # server clock -- matches how campaigns.sent_at is written/compared below
    # scheduled_at holds the clinic's LOCAL wall-clock digits (never UTC),
    # so dormancy must be measured against clinic-local "now", not the
    # server's own clock -- otherwise this silently drifts by the clinic's
    # UTC offset (same bug class as the reminder-lateness issue).
    now_clinic = now_local()

    segments_res = await _db(lambda: supabase.table("recall_segments").select(
        "id, tenant_id, service_type, is_default, interval_months, message_template, whatsapp_template_id"
    ).eq("enabled", True).execute())

    segments_by_tenant: dict = defaultdict(list)
    for seg in (segments_res.data or []):
        segments_by_tenant[seg["tenant_id"]].append(seg)

    # Every recall recipient is by definition a dormant patient outside
    # WhatsApp's 24h customer-service window -- Meta requires a pre-approved
    # template for that, and rejects plain text sends outright. Batch-load
    # every segment's linked template (only approved ones are usable) once,
    # up front, instead of a per-contact lookup.
    _template_ids = list({
        seg["whatsapp_template_id"]
        for segs in segments_by_tenant.values() for seg in segs
        if seg.get("whatsapp_template_id")
    })
    templates_by_id: dict = {}
    if _template_ids:
        templates_res = await _db(lambda: supabase.table("whatsapp_templates").select(
            "id, name, language, status, variables, header_media_id"
        ).in_("id", _template_ids).eq("status", "approved").execute())
        templates_by_id = {t["id"]: t for t in (templates_res.data or [])}

    for tenant_id, segments in segments_by_tenant.items():
        try:
            # get_tenant_by_id (not a raw table select) so wa_access_token
            # comes back decrypted -- a raw select would hand this loop
            # ciphertext instead of a usable Meta token.
            tenant = await get_tenant_by_id(tenant_id)
            if not tenant or not tenant.is_active:
                continue

            clinic_name     = tenant.name or "our clinic"
            phone_number_id = tenant.wa_phone_number_id
            access_token    = tenant.wa_access_token
            if not phone_number_id or not access_token:
                continue

            # Most-recent non-cancelled booking per contact — each dormant
            # candidate is matched against the segment for their LATEST
            # treatment type, not just any booking they ever had.
            _tid2 = tenant_id
            bookings_res = await _db(lambda: supabase.table("bookings").select(
                "contact_id, service_type, scheduled_at"
            ).eq("tenant_id", _tid2).not_.in_(
                "status", ["cancelled"]
            ).order("scheduled_at", desc=True).execute())

            latest_by_contact: dict = {}
            for b in (bookings_res.data or []):
                cid = b.get("contact_id")
                if cid and cid not in latest_by_contact:
                    latest_by_contact[cid] = b  # first hit per contact = most recent (desc order)

            # Match each contact to a segment and check dormancy against
            # THAT segment's own interval (intervals vary per segment now,
            # so there's no single tenant-wide cutoff anymore).
            dormant: dict = {}  # contact_id -> matched segment
            for cid, booking in latest_by_contact.items():
                segment = _match_recall_segment(booking.get("service_type", ""), segments)
                if not segment:
                    continue
                seg_months = segment.get("interval_months") or 6
                seg_cutoff = now_clinic - timedelta(days=seg_months * 30)
                scheduled_at = from_db_timestamp(booking["scheduled_at"])
                if scheduled_at < seg_cutoff:
                    dormant[cid] = segment

            if not dormant:
                continue

            # Dedup: skip contacts already recalled within their own segment's window
            _tid3 = tenant_id
            contact_ids = list(dormant.keys())
            existing_res = await _db(lambda: supabase.table("campaigns").select(
                "contact_id, sent_at"
            ).eq("tenant_id", _tid3).eq("type", "recall").in_(
                "contact_id", contact_ids
            ).execute())
            last_recall_by_contact: dict = {}
            for c in (existing_res.data or []):
                cid = c["contact_id"]
                sent_at = c.get("sent_at")
                if sent_at and sent_at > last_recall_by_contact.get(cid, ""):
                    last_recall_by_contact[cid] = sent_at

            to_contact = []
            for cid, segment in dormant.items():
                seg_months = segment.get("interval_months") or 6
                seg_cutoff = (now - timedelta(days=seg_months * 30)).isoformat()
                last_sent = last_recall_by_contact.get(cid)
                if last_sent and last_sent >= seg_cutoff:
                    continue
                to_contact.append(cid)

            # Cap at 50/tenant/run across ALL segments combined — the cap
            # protects the tenant's single WhatsApp Business Account from
            # quota/spam-flagging risk, which is a per-tenant resource
            # regardless of how many segments the clinic has configured.
            to_contact = to_contact[:50]
            if not to_contact:
                continue

            for contact_id in to_contact:
                segment = dormant[contact_id]
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
                service = latest_by_contact[contact_id].get("service_type") or ""

                wa_tmpl = templates_by_id.get(segment.get("whatsapp_template_id") or "")
                if not wa_tmpl:
                    # No approved marketing template linked to this segment
                    # yet -- skip rather than attempt a freeform send Meta
                    # will reject anyway. The clinic sets this up once in
                    # the dashboard's Marketing Templates page.
                    logger.info(
                        f"Recall skipped, no approved template linked | tenant={tenant_id} | "
                        f"contact={contact_id} | segment={segment.get('id')}"
                    )
                    continue

                available_values = {"name": name, "clinic": clinic_name, "service": service}
                variables = wa_tmpl.get("variables") or []
                params = [available_values.get(v, "") for v in variables]
                # Readable thread-history log only -- the real send always
                # uses the fixed, Meta-approved template text.
                body_preview = segment.get("message_template") or DEFAULT_RECALL_MSG
                message = body_preview.replace("{name}", name).replace("{clinic}", clinic_name).replace("{service}", service)

                try:
                    await send_whatsapp_template(
                        phone, wa_tmpl["name"], wa_tmpl.get("language") or "en", params,
                        phone_number_id, access_token,
                        header_image_id=wa_tmpl.get("header_media_id"),
                    )

                    _p = phone
                    thread_res = await _db(lambda: supabase.table("whatsapp_threads").select("id").eq(
                        "tenant_id", tenant_id
                    ).eq("contact_number", _p).order("created_at", desc=True).limit(1).execute())
                    thread_id = thread_res.data[0]["id"] if thread_res.data else None

                    _cid2 = contact_id
                    _thid = thread_id
                    _ctx  = {"message": message}
                    await _db(lambda: supabase.table("campaigns").insert({
                        "tenant_id":  tenant_id,
                        "contact_id": _cid2,
                        "thread_id":  _thid,
                        "type":       "recall",
                        "status":     "sent",
                        "sent_at":    datetime.now().isoformat(),
                        "context":    _ctx,
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

                    logger.info(f"Recall sent | tenant={tenant_id} | contact={contact_id} | segment={segment.get('id')}")

                except Exception as e:
                    logger.error(f"Recall send failed | tenant={tenant_id} | contact={contact_id} | {e}")

        except Exception as e:
            logger.error(f"Recall messages: tenant {tenant_id} failed, skipping | {e}", exc_info=True)
            continue


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
