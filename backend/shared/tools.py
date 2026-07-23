"""
Tool Functions — used by the WhatsApp agent.
All tools write to Supabase and optionally sync to Google Calendar / Sheets.
Guardrails: double-booking prevention, rate limiting, business-hours validation.
All Supabase calls use _db() to avoid blocking the async event loop.
"""

import logging
from typing import Dict, Any, Optional, List
from datetime import datetime, timedelta

import httpx

from shared.tenant_config import get_supabase_client, TenantConfig, _db, _db_optional
from shared.google_integrations import get_google_calendar, get_google_sheets

logger = logging.getLogger(__name__)


# ── Guardrail helpers ──────────────────────────────────────────────────────────

def validate_booking_time(
    scheduled_at: datetime,
    business_hours: Dict,
    timezone: str = "Asia/Kuala_Lumpur",
) -> Dict[str, Any]:
    try:
        from zoneinfo import ZoneInfo
        now = datetime.now(tz=ZoneInfo(timezone)).replace(tzinfo=None)
    except Exception:
        now = datetime.now()
    if scheduled_at < now:
        return {"valid": False, "error": "Cannot book appointments in the past."}
    if scheduled_at > now + timedelta(days=90):
        return {"valid": False, "error": "For bookings more than 3 months out, please contact us directly."}

    day_name = scheduled_at.strftime("%a").lower()
    day_hours = business_hours.get(day_name)
    if not day_hours or day_hours.get("closed"):
        return {"valid": False, "error": f"We're closed on {scheduled_at.strftime('%A')}s."}

    time_str = scheduled_at.strftime("%H:%M")
    if not (day_hours["open"] <= time_str <= day_hours["close"]):
        return {"valid": False, "error": (
            f"That time is outside our hours. "
            f"We're open {day_hours['open']} to {day_hours['close']}."
        )}
    return {"valid": True}


async def check_booking_rate_limit(tenant_id: str, contact_id: str) -> bool:
    """Allow max 5 bookings per contact per day."""
    supabase = get_supabase_client()
    today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    result = await _db(lambda: supabase.table("bookings").select("id").eq(
        "tenant_id", tenant_id
    ).eq("contact_id", contact_id).gte(
        "created_at", today_start.isoformat()
    ).execute())
    return len(result.data) < 5


# ── Appointment tools ──────────────────────────────────────────────────────────

async def book_appointment(
    tenant_id: str,
    contact_id: str,
    contact_name: str,
    contact_phone: str,
    service_type: str,
    scheduled_at: datetime,
    tenant_config: Optional[TenantConfig] = None,
    notes: Optional[str] = None,
    source: str = "whatsapp",
    custom_fields: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    supabase = get_supabase_client()

    if tenant_config:
        validation = validate_booking_time(
            scheduled_at, tenant_config.business_hours,
            timezone=getattr(tenant_config, "timezone", "Asia/Kuala_Lumpur"),
        )
        if not validation["valid"]:
            return {"success": False, "error": "invalid_time", "message": validation["error"]}

    if not await check_booking_rate_limit(tenant_id, contact_id):
        return {
            "success": False,
            "error": "rate_limit",
            "message": "You've reached the maximum bookings for today. Please call us for additional appointments.",
        }

    time_start = (scheduled_at - timedelta(minutes=15)).isoformat()
    time_end = (scheduled_at + timedelta(minutes=45)).isoformat()
    existing = await _db(lambda: supabase.table("bookings").select("id, scheduled_at").eq(
        "tenant_id", tenant_id
    ).in_("status", ["pending", "confirmed"]).gte(
        "scheduled_at", time_start
    ).lte("scheduled_at", time_end).execute())

    if existing.data:
        conflict_time = datetime.fromisoformat(existing.data[0]["scheduled_at"]).strftime("%I:%M %p")
        return {
            "success": False,
            "error": "double_booking",
            "message": f"That time slot is already taken (appointment at {conflict_time}). Would you like to try another time?",
        }

    # The check above is a fast, friendly pre-flight — it is NOT atomic with
    # the insert below, so two near-simultaneous bookings for the same slot
    # could both pass it. The `bookings_no_overlap` exclusion constraint
    # (Postgres-level, see migration 009) is what actually prevents the
    # double-booking: if the race window is hit, the insert itself fails and
    # we catch that specific error here instead of returning a generic one.
    # `details` (JSONB) holds the full record including notes + custom fields.
    # `notes` (a separate flat column) is also set for the dashboard's existing
    # "Notes" display, which reads that column directly rather than details.
    details: Dict[str, Any] = dict(custom_fields or {})
    if notes:
        details["notes"] = notes

    try:
        result = await _db(lambda: supabase.table("bookings").insert({
            "tenant_id": tenant_id,
            "contact_id": contact_id,
            "scheduled_at": scheduled_at.isoformat(),
            "service_type": service_type,
            "details": details,
            "notes": notes,
            "source": source,
            "status": "pending",
        }).execute())
    except Exception as e:
        if "23P01" in str(e) or "exclusion" in str(e).lower() or "bookings_no_overlap" in str(e):
            return {
                "success": False,
                "error": "double_booking",
                "message": "That time slot was just taken by another booking. Would you like to try another time?",
            }
        raise

    if not result.data:
        return {"success": False, "error": "Failed to create booking"}

    booking_id = result.data[0]["id"]
    calendar_event_id = None

    gcal = await get_google_calendar(tenant_id)
    if gcal:
        try:
            cal_result = await gcal.create_appointment(
                summary=f"{service_type} - {contact_name}",
                start_time=scheduled_at,
                end_time=scheduled_at + timedelta(minutes=30),
                patient_name=contact_name,
                patient_phone=contact_phone,
                service_type=service_type,
                notes=notes,
            )
            if cal_result.get("success"):
                calendar_event_id = cal_result.get("event_id")
                await _db(lambda: supabase.table("bookings").update(
                    {"calendar_event_id": calendar_event_id}
                ).eq("id", booking_id).execute())
        except Exception as e:
            logger.warning(f"Calendar sync failed (non-fatal): {e}")

    gsheets = await get_google_sheets(tenant_id)
    if gsheets:
        try:
            await gsheets.log_lead(
                name=contact_name,
                phone=contact_phone,
                source=source,
                status="booked",
                service_interest=service_type,
                notes=f"Booked for {scheduled_at.strftime('%Y-%m-%d %H:%M')}"
                + (f" — {notes}" if notes else ""),
                custom_fields=custom_fields,
            )
        except Exception as e:
            logger.warning(f"Sheets sync failed (non-fatal): {e}")

    return {
        "success": True,
        "booking_id": booking_id,
        "calendar_event_id": calendar_event_id,
        "scheduled_at": scheduled_at.isoformat(),
    }


async def check_slots(
    tenant_id: str,
    service_type: str,
    date: datetime,
    tenant_config: TenantConfig,
) -> Dict[str, Any]:
    gcal = await get_google_calendar(tenant_id)
    if gcal:
        day_name = date.strftime("%a").lower()
        business_hours = tenant_config.business_hours.get(
            day_name, {"open": "09:00", "close": "18:00"}
        )
        free_slots = await gcal.find_free_slots(
            date=date, duration_minutes=30, business_hours=business_hours
        )
        return {
            "success": True,
            "date": date.date().isoformat(),
            "available_slots": [
                {"time": s["start"].strftime("%H:%M"), "datetime": s["start"].isoformat()}
                for s in free_slots[:10]
            ],
            "source": "google_calendar",
        }

    supabase = get_supabase_client()
    date_start = date.replace(hour=0, minute=0, second=0)
    date_end = date.replace(hour=23, minute=59, second=59)

    bookings = await _db(lambda: supabase.table("bookings").select("scheduled_at").eq(
        "tenant_id", tenant_id
    ).gte("scheduled_at", date_start.isoformat()).lte(
        "scheduled_at", date_end.isoformat()
    ).execute())

    booked_times = {
        datetime.fromisoformat(b["scheduled_at"]).strftime("%H:%M") for b in bookings.data
    }

    day_name = date.strftime("%a").lower()
    hours = tenant_config.business_hours.get(day_name, {"open": "09:00", "close": "18:00"})
    if hours.get("closed"):
        return {"success": True, "date": date.date().isoformat(), "available_slots": [], "source": "supabase"}

    available = []
    current = datetime.strptime(hours["open"], "%H:%M")
    end = datetime.strptime(hours["close"], "%H:%M")
    while current < end:
        time_str = current.strftime("%H:%M")
        if time_str not in booked_times:
            slot_dt = date.replace(hour=current.hour, minute=current.minute)
            available.append({"time": time_str, "datetime": slot_dt.isoformat()})
        current += timedelta(minutes=30)

    return {
        "success": True,
        "date": date.date().isoformat(),
        "available_slots": available[:10],
        "source": "supabase",
    }


async def cancel_appointment(
    tenant_id: str,
    contact_id: str,
    booking_id: Optional[str] = None,
    custom_fields: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    # contact_id must always come from the server-resolved conversation
    # context (the person actually texting), never from the LLM's tool-call
    # arguments — otherwise a crafted message like "cancel the appointment
    # for +60123456789" could let one patient cancel/reschedule another
    # patient's booking. booking_id is scoped by contact_id too, so even a
    # guessed/leaked booking UUID from another patient can't match here.
    supabase = get_supabase_client()

    if booking_id:
        _bid_lookup = booking_id
        booking = await _db_optional(lambda: supabase.table("bookings").select("*").eq(
            "id", _bid_lookup
        ).eq("tenant_id", tenant_id).eq("contact_id", contact_id).maybe_single().execute())
    else:
        booking = await _db_optional(lambda: supabase.table("bookings").select("*").eq(
            "tenant_id", tenant_id
        ).eq("contact_id", contact_id).eq(
            "status", "pending"
        ).order("scheduled_at", desc=True).limit(1).maybe_single().execute())

    if not booking.data:
        return {"success": False, "error": "Booking not found"}

    scheduled = datetime.fromisoformat(booking.data["scheduled_at"])
    if scheduled - datetime.now() < timedelta(hours=2):
        return {
            "success": False,
            "error": "too_close",
            "message": "For cancellations this close to the appointment, please call us directly.",
        }

    _bid = booking.data["id"]
    update_data: Dict[str, Any] = {"status": "cancelled"}
    if custom_fields:
        update_data["details"] = {**(booking.data.get("details") or {}), **custom_fields}
    await _db(lambda: supabase.table("bookings").update(update_data).eq("id", _bid).execute())

    calendar_event_id = booking.data.get("calendar_event_id")
    if calendar_event_id:
        gcal = await get_google_calendar(tenant_id)
        if gcal:
            await gcal.delete_appointment(calendar_event_id)

    gsheets = await get_google_sheets(tenant_id)
    if gsheets:
        try:
            contact_res = await _db_optional(lambda: supabase.table("contacts").select(
                "name, phone"
            ).eq("id", contact_id).maybe_single().execute())
            contact_data = contact_res.data or {}
            await gsheets.log_lead(
                name=contact_data.get("name") or "Unknown",
                phone=contact_data.get("phone") or "",
                source="whatsapp",
                status="cancelled",
                notes=f"Cancelled appointment originally at {scheduled.strftime('%Y-%m-%d %H:%M')}",
                custom_fields=custom_fields,
            )
        except Exception as e:
            logger.warning(f"Sheets sync failed (non-fatal): {e}")

    return {"success": True, "booking_id": _bid, "scheduled_at": booking.data["scheduled_at"]}


async def reschedule_appointment(
    tenant_id: str,
    contact_id: str,
    new_date: str,
    new_time: str,
    booking_id: Optional[str] = None,
    custom_fields: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    # See the same note in cancel_appointment — contact_id is always the
    # server-resolved current contact, never LLM-supplied, and booking_id
    # (if given) is scoped by it too.
    from shared.utils import parse_datetime
    supabase = get_supabase_client()
    new_scheduled_at = parse_datetime(new_date, new_time)
    if not new_scheduled_at:
        return {"success": False, "error": "Invalid date or time format"}

    if booking_id:
        _bid_lookup = booking_id
        booking = await _db_optional(lambda: supabase.table("bookings").select("*").eq(
            "id", _bid_lookup
        ).eq("tenant_id", tenant_id).eq("contact_id", contact_id).maybe_single().execute())
    else:
        booking = await _db_optional(lambda: supabase.table("bookings").select("*").eq(
            "tenant_id", tenant_id
        ).eq("contact_id", contact_id).eq(
            "status", "pending"
        ).order("scheduled_at", desc=True).limit(1).maybe_single().execute())

    if not booking.data:
        return {"success": False, "error": "Booking not found"}

    old_scheduled_at = booking.data["scheduled_at"]
    _bid = booking.data["id"]
    update_data: Dict[str, Any] = {"scheduled_at": new_scheduled_at.isoformat()}
    if custom_fields:
        update_data["details"] = {**(booking.data.get("details") or {}), **custom_fields}
    await _db(lambda: supabase.table("bookings").update(update_data).eq("id", _bid).execute())

    calendar_event_id = booking.data.get("calendar_event_id")
    if calendar_event_id:
        gcal = await get_google_calendar(tenant_id)
        if gcal:
            end_time = new_scheduled_at + timedelta(minutes=30)
            await gcal.update_appointment(
                event_id=calendar_event_id,
                updates={
                    "start": {"dateTime": new_scheduled_at.isoformat(), "timeZone": "Asia/Kuala_Lumpur"},
                    "end": {"dateTime": end_time.isoformat(), "timeZone": "Asia/Kuala_Lumpur"},
                },
            )

    gsheets = await get_google_sheets(tenant_id)
    if gsheets:
        try:
            contact_res = await _db_optional(lambda: supabase.table("contacts").select(
                "name, phone"
            ).eq("id", contact_id).maybe_single().execute())
            contact_data = contact_res.data or {}
            await gsheets.log_lead(
                name=contact_data.get("name") or "Unknown",
                phone=contact_data.get("phone") or "",
                source="whatsapp",
                status="rescheduled",
                notes=f"Rescheduled from {old_scheduled_at} to {new_scheduled_at.strftime('%Y-%m-%d %H:%M')}",
                custom_fields=custom_fields,
            )
        except Exception as e:
            logger.warning(f"Sheets sync failed (non-fatal): {e}")

    return {
        "success": True,
        "booking_id": _bid,
        "old_time": old_scheduled_at,
        "new_time": new_scheduled_at.isoformat(),
    }


# ── Contact management ─────────────────────────────────────────────────────────

async def get_or_create_contact(
    tenant_id: str,
    phone: str,
    name: Optional[str] = None,
    language: Optional[str] = None,
    source: str = "whatsapp",
) -> Dict[str, Any]:
    supabase = get_supabase_client()

    result = await _db(lambda: supabase.table("contacts").select("*").eq(
        "tenant_id", tenant_id
    ).eq("phone", phone).execute())

    if result.data:
        contact = result.data[0]
        await _db(lambda: supabase.table("contacts").update(
            {"last_contact_at": datetime.now().isoformat()}
        ).eq("id", contact["id"]).execute())
        return {"success": True, "contact": contact, "is_new": False}

    new_contact = await _db(lambda: supabase.table("contacts").insert({
        "tenant_id": tenant_id,
        "phone": phone,
        "name": name,
        "language_preference": language,
        "last_contact_at": datetime.now().isoformat(),
    }).execute())

    if not new_contact.data:
        return {"success": False, "error": "Failed to create contact"}

    contact = new_contact.data[0]

    gsheets = await get_google_sheets(tenant_id)
    if gsheets:
        try:
            await gsheets.log_lead(
                name=name or "Unknown",
                phone=phone,
                source=source,
                status="new",
                notes="First contact",
            )
        except Exception as e:
            logger.warning(f"Failed to log new lead to Sheets (non-fatal): {e}")

    return {"success": True, "contact": contact, "is_new": True}


async def lookup_patient(tenant_id: str, phone: str) -> Dict[str, Any]:
    """
    Read-only patient lookup by phone number — unlike get_or_create_contact,
    never creates a record. Lets a clinic's own conversation flow ask
    "new or existing patient?" and branch on a real answer instead of
    guessing. Phone is the match key (already how contacts are deduped
    everywhere else); name is not used for matching since it's unreliable
    (misspellings, nicknames, booking on someone else's behalf).
    """
    from shared.utils import format_phone_number

    supabase = get_supabase_client()
    formatted = format_phone_number(phone)

    result = await _db(lambda: supabase.table("contacts").select("id, name, created_at").eq(
        "tenant_id", tenant_id
    ).eq("phone", formatted).execute())

    if not result.data:
        return {"success": True, "found": False}

    contact = result.data[0]
    last_booking = await _db_optional(lambda: supabase.table("bookings").select(
        "service_type, scheduled_at, status"
    ).eq("tenant_id", tenant_id).eq("contact_id", contact["id"]).order(
        "scheduled_at", desc=True
    ).limit(1).maybe_single().execute())

    return {
        "success": True,
        "found": True,
        "name": contact.get("name"),
        "last_booking": last_booking.data if last_booking else None,
    }


# ── FAQ ────────────────────────────────────────────────────────────────────────

async def get_faq(tenant_config: TenantConfig, question: str) -> Dict[str, Any]:
    faq_list = tenant_config.faq
    if not faq_list:
        return {"success": False, "answer": None, "error": "No FAQ configured"}

    question_lower = question.lower()
    best_match = None
    best_score = 0
    for item in faq_list:
        q = item.get("q", "").lower()
        score = sum(1 for word in question_lower.split() if word in q)
        if score > best_score:
            best_score = score
            best_match = item

    if best_match and best_score > 0:
        return {"success": True, "question": best_match["q"], "answer": best_match["a"]}
    return {"success": False, "answer": None, "error": "No matching FAQ found"}


# ── Escalation ─────────────────────────────────────────────────────────────────

async def escalate_to_human(
    tenant_id: str,
    reason: str,
    context: str,
    source: str = "whatsapp",
    contact_name: str = "",
    contact_phone: str = "",
) -> Dict[str, Any]:
    supabase = get_supabase_client()
    await _db(lambda: supabase.table("escalations").insert({
        "tenant_id": tenant_id,
        "reason": reason,
        "context": context,
        "source": source,
        "created_at": datetime.now().isoformat(),
    }).execute())

    # Notify staff via WhatsApp if escalation_number is configured
    from shared.tenant_config import get_tenant_by_id
    tenant = await get_tenant_by_id(tenant_id)
    if tenant and tenant.escalation_number and tenant.wa_phone_number_id and tenant.wa_access_token:
        who = f"{contact_name} ({contact_phone})" if contact_name else contact_phone or "Unknown"
        alert = (
            f"🚨 *Escalation Alert*\n"
            f"Reason: {reason}\n"
            f"Contact: {who}\n"
            f"Context: {context}\n"
            f"Source: {source}"
        )
        to = tenant.escalation_number.replace("+", "").replace(" ", "")
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(
                    f"https://graph.facebook.com/v21.0/{tenant.wa_phone_number_id}/messages",
                    headers={"Authorization": f"Bearer {tenant.wa_access_token}",
                             "Content-Type": "application/json"},
                    json={"messaging_product": "whatsapp", "to": to,
                          "type": "text", "text": {"body": alert}},
                )
        except Exception as _e:
            logger.warning(f"Escalation WA notification failed: {_e}")

    return {
        "success": True,
        "action": "notify_staff",
        "reason": reason,
    }


# ── Base booking field labels ──────────────────────────────────────────────────
# A clinic can relabel these 5 fixed tool arguments in Agent Configuration —
# e.g. a lawyer's office renaming "service_type" to "Case Type" — without the
# underlying JSON key ever changing (book_appointment() and the bookings
# table depend on these exact keys). The hint is the fixed part of each
# property's description (format/example), the label is the swappable part.
BASE_FIELD_HINTS = {
    "contact_name": "the patient's full name (must be confirmed by user)",
    "contact_phone": "the patient's phone number (must be confirmed by user)",
    "service_type": "e.g. scaling, checkup, whitening",
    "date": "YYYY-MM-DD format",
    "time": "HH:MM 24-hour format",
}


# ── LLM tool definitions (for WhatsApp text mode) ─────────────────────────────

TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "book_appointment",
            "description": (
                "Book an appointment for a patient. Creates booking in system "
                "and syncs to Google Calendar if connected."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "contact_name": {"type": "string", "description": "Patient's full name (must be confirmed by user)"},
                    "contact_phone": {"type": "string", "description": "Patient's phone number (must be confirmed by user)"},
                    "service_type": {"type": "string", "description": "Type of service, e.g. scaling, checkup, whitening"},
                    "date": {"type": "string", "description": "Appointment date in YYYY-MM-DD format"},
                    "time": {"type": "string", "description": "Appointment time in HH:MM 24-hour format"},
                    "notes": {"type": "string", "description": "Optional notes"},
                },
                "required": ["contact_name", "contact_phone", "service_type", "date", "time"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_slots",
            "description": "Check available appointment slots for a specific date.",
            "parameters": {
                "type": "object",
                "properties": {
                    "date": {"type": "string", "description": "Date to check in YYYY-MM-DD format"},
                    "service_type": {"type": "string", "description": "Service type (optional)"},
                },
                "required": ["date"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "lookup_patient",
            "description": (
                "Check whether someone is already a patient on file, by phone number. "
                "Read-only — never creates a record. Use this whenever the clinic's "
                "flow asks you to tell a new patient from a returning one."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "contact_phone": {"type": "string", "description": "Phone number to search for (must be confirmed by user)"},
                    "contact_name": {"type": "string", "description": "Name as given by the caller (optional — matching is by phone, this is for context only)"},
                },
                "required": ["contact_phone"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_faq",
            "description": "Search the clinic's FAQ for answers about hours, location, services, pricing.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {"type": "string", "description": "Question to search"},
                },
                "required": ["question"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cancel_appointment",
            "description": "Cancel the most recent pending appointment for the patient in this conversation. Always acts on the current patient — never a different phone number.",
            "parameters": {
                "type": "object",
                "properties": {
                    "booking_id": {"type": "string", "description": "Booking ID, if already known from earlier in this conversation (optional — omit to cancel the current patient's most recent pending booking)"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "reschedule_appointment",
            "description": "Reschedule the current patient's existing appointment to a new date and time. Always acts on the current patient — never a different phone number.",
            "parameters": {
                "type": "object",
                "properties": {
                    "new_date": {"type": "string", "description": "New appointment date in YYYY-MM-DD format"},
                    "new_time": {"type": "string", "description": "New appointment time in HH:MM 24-hour format"},
                    "booking_id": {"type": "string", "description": "Booking ID, if already known from earlier in this conversation (optional — omit to reschedule the current patient's most recent pending booking)"},
                },
                "required": ["new_date", "new_time"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "escalate_to_human",
            "description": "Transfer the conversation to a human staff member.",
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": {"type": "string", "description": "Reason for escalation"},
                },
                "required": ["reason"],
            },
        },
    },
]

# Names a clinic can't reuse for a custom tool function's key — they'd
# collide with one of these built-in, hardcoded-behavior tools.
RESERVED_TOOL_NAMES = {t["function"]["name"] for t in TOOL_DEFINITIONS}


async def run_custom_tool(tenant_id: str, contact: Dict[str, Any], tool_def: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
    """
    Execute a clinic-defined custom tool: no appointment logic, just collect
    whatever fields the clinic declared and log them. Always persisted to
    custom_tool_submissions (so nothing is lost even without Sheets
    connected), then mirrored to Google Sheets the same way bookings are —
    via the generic header-matching writer, so a clinic's own column layout
    just works without any code change per tool.
    """
    fields = {
        f["key"]: args[f["key"]]
        for f in tool_def.get("fields", [])
        if f.get("key") and args.get(f["key"])
    }
    tool_key = tool_def.get("tool_key", "")
    tool_name = tool_def.get("name") or tool_key

    supabase = get_supabase_client()
    try:
        await _db(lambda: supabase.table("custom_tool_submissions").insert({
            "tenant_id": tenant_id,
            "contact_id": contact.get("id"),
            "tool_key": tool_key,
            "tool_name": tool_name,
            "fields": fields,
        }).execute())
    except Exception as e:
        logger.warning(f"Failed to save custom tool submission (non-fatal): {e}")

    gsheets = await get_google_sheets(tenant_id)
    if gsheets:
        try:
            await gsheets.log_lead(
                name=contact.get("name") or "Unknown",
                phone=contact.get("phone") or "",
                source="whatsapp",
                status=tool_key,
                notes=tool_name,
                custom_fields=fields,
            )
        except Exception as e:
            logger.warning(f"Failed to log custom tool submission to Sheets (non-fatal): {e}")

    return {"success": True}
