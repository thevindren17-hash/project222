"""
Agent Test Endpoint
Lets the dashboard owner chat with the AI agent using their live config.
All tools run for real in test mode so the full flow can be verified.
"""

import re
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from shared.tenant_config import get_tenant_by_id
from shared.providers import load_llm_client
from shared.tools import TOOL_DEFINITIONS, get_faq
from shared.utils import logger

router = APIRouter()


class TestMessage(BaseModel):
    tenant_id: str
    message: str
    history: list = []


# ── Day-name tables ────────────────────────────────────────────────────────────

_EN_DAYS = {
    "monday": 0, "mon": 0,
    "tuesday": 1, "tue": 1, "tues": 1,
    "wednesday": 2, "wed": 2,
    "thursday": 3, "thu": 3, "thur": 3, "thurs": 3,
    "friday": 4, "fri": 4,
    "saturday": 5, "sat": 5,
    "sunday": 6, "sun": 6,
}

# Malay day names → weekday index (Monday=0)
_MS_DAYS = {
    "isnin": 0,
    "selasa": 1,
    "rabu": 2,
    "khamis": 3,
    "jumaat": 4,
    "sabtu": 5,
    "ahad": 6, "minggu": 6,
}

# Malay time-of-day suffixes
_MS_TIME_SUFFIX = {
    "pagi": "am",    # morning
    "tengahari": "pm",  # noon/afternoon  (12–14)
    "petang": "pm",  # afternoon/evening (14–18)
    "malam": "pm",   # night (18–23)
}


def _next_weekday(today: datetime, weekday: int, allow_today: bool = False) -> datetime:
    """Return the next occurrence of `weekday` (0=Mon … 6=Sun) after today."""
    days_ahead = weekday - today.weekday()
    if days_ahead < 0 or (days_ahead == 0 and not allow_today):
        days_ahead += 7
    return today + timedelta(days=days_ahead)


def _resolve_date(date_str: str) -> Optional[datetime]:
    """
    Parse a date string that may be:
      - ISO format: 2026-05-14
      - English relative: today, tomorrow, next friday, in 3 days, next week
      - Malay relative: esok, lusa, hari ini, isnin depan, minggu depan, selasa ini
    Returns a datetime at midnight, or None on failure.
    """
    s = date_str.lower().strip()
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)

    # ── Hard-coded placeholder guard ──────────────────────────────────────────
    if s in ("yyyy-mm-dd", "date", "[date]", "dd/mm/yyyy", "mm/dd/yyyy", ""):
        return None

    # ── Absolute ISO / slash formats ─────────────────────────────────────────
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(s, fmt).replace(hour=0, minute=0, second=0, microsecond=0)
        except ValueError:
            pass

    # ── English absolute ─────────────────────────────────────────────────────
    if s in ("today", "today's date", "now"):
        return today
    if s in ("tomorrow", "tmr", "tom", "the next day"):
        return today + timedelta(days=1)
    if s in ("yesterday",):
        return today - timedelta(days=1)
    if s in ("day after tomorrow", "day after tmr"):
        return today + timedelta(days=2)

    # ── Malay absolute ───────────────────────────────────────────────────────
    if s in ("hari ini", "harini"):
        return today
    if s in ("esok", "besok"):
        return today + timedelta(days=1)
    if s in ("lusa",):
        return today + timedelta(days=2)

    # ── "in X days / weeks" ──────────────────────────────────────────────────
    m = re.match(r"in\s+(\d+)\s+(day|days)", s)
    if m:
        return today + timedelta(days=int(m.group(1)))
    m = re.match(r"in\s+(\d+)\s+(week|weeks)", s)
    if m:
        return today + timedelta(weeks=int(m.group(1)))

    # ── English "next <weekday>" / "this <weekday>" ──────────────────────────
    m = re.match(r"(next|this|coming)\s+(\w+)", s)
    if m:
        qualifier, day_name = m.group(1), m.group(2)
        if day_name in _EN_DAYS:
            wd = _EN_DAYS[day_name]
            # "this monday" = nearest upcoming including today; "next monday" = after this week
            allow_today = qualifier == "this"
            return _next_weekday(today, wd, allow_today=allow_today)

    # ── Plain English weekday (no qualifier) → nearest future ────────────────
    if s in _EN_DAYS:
        return _next_weekday(today, _EN_DAYS[s])

    # ── Malay "<day> depan / ini / hadapan" ──────────────────────────────────
    m = re.match(r"(\w+)\s+(depan|hadapan|ini|ni)", s)
    if m:
        day_name, qualifier = m.group(1), m.group(2)
        if day_name in _MS_DAYS:
            wd = _MS_DAYS[day_name]
            allow_today = qualifier in ("ini", "ni")
            return _next_weekday(today, wd, allow_today=allow_today)

    # ── Plain Malay weekday ───────────────────────────────────────────────────
    if s in _MS_DAYS:
        return _next_weekday(today, _MS_DAYS[s])

    # ── "minggu depan" = next week (same weekday) ────────────────────────────
    if s in ("minggu depan", "minggu hadapan", "next week"):
        return today + timedelta(weeks=1)
    if s in ("minggu lepas", "last week"):
        return today - timedelta(weeks=1)

    # ── Ordinal patterns: "the 15th", "15th of may" ──────────────────────────
    months = {
        "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
        "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6,
        "jul": 7, "july": 7, "aug": 8, "august": 8, "sep": 9, "september": 9,
        "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
        # Malay months
        "januari": 1, "februari": 2, "mac": 3, "april": 4, "mei": 5, "jun": 6,
        "julai": 7, "ogos": 8, "september": 9, "oktober": 10, "november": 11, "disember": 12,
    }
    m = re.match(r"(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(\w+)(?:\s+(\d{4}))?", s)
    if m:
        day_n, month_name, year_str = int(m.group(1)), m.group(2), m.group(3)
        if month_name in months:
            year = int(year_str) if year_str else today.year
            try:
                d = datetime(year, months[month_name], day_n)
                if d < today and not year_str:
                    d = d.replace(year=today.year + 1)
                return d
            except ValueError:
                pass

    return None


def _resolve_time(time_str: str) -> Optional[tuple[int, int]]:
    """
    Parse a time string and return (hour, minute) in 24-h, or None.
    Handles: 9:00, 09:00, 14:30, 9am, 9 am, 3pm, 3 pm,
             9 pagi, 3 petang, 8 malam, tengahari (noon),
             hh:mm literal guard.
    """
    s = time_str.lower().strip()

    if s in ("hh:mm", "time", "[time]", ""):
        return None

    # ── Malay: tengahari = 12:00 ─────────────────────────────────────────────
    if s in ("tengahari", "noon", "12 pm", "12pm"):
        return (12, 0)

    # ── "X pagi/petang/malam" ─────────────────────────────────────────────────
    m = re.match(r"(\d{1,2})(?::(\d{2}))?\s*(pagi|petang|malam|tengahari|am|pm)", s)
    if m:
        h, mn, suffix = int(m.group(1)), int(m.group(2) or 0), m.group(3)
        if suffix in ("pm", "petang", "malam") and h != 12:
            h += 12
        if suffix in ("am", "pagi") and h == 12:
            h = 0
        # Adjust for context: "3 petang" = 3 PM; "8 malam" = 8 PM (already +12)
        if suffix == "tengahari" and h < 12:
            h = 12
        return (h % 24, mn)

    # ── HH:MM 24-h ───────────────────────────────────────────────────────────
    m = re.match(r"^(\d{1,2}):(\d{2})$", s)
    if m:
        return (int(m.group(1)) % 24, int(m.group(2)))

    # ── Plain hour ────────────────────────────────────────────────────────────
    m = re.match(r"^(\d{1,2})$", s)
    if m:
        h = int(m.group(1))
        # Treat bare hours <8 as PM (unlikely someone books at 1am)
        if h < 8:
            h += 12
        return (h % 24, 0)

    return None


def _resolve_datetime(date_str: str, time_str: str) -> Optional[datetime]:
    """Combine a natural-language date and time into a datetime."""
    date = _resolve_date(date_str)
    if not date:
        return None
    parsed = _resolve_time(time_str)
    if not parsed:
        return None
    h, mn = parsed
    return date.replace(hour=h, minute=mn)


# ── Tool dispatcher ────────────────────────────────────────────────────────────

async def _run_tool(fn: str, args: dict, tenant_id: str, tenant) -> str:
    """Execute a single tool and return a human-readable result string."""

    if fn == "get_faq":
        res = await get_faq(tenant, args.get("question", ""))
        return res.get("answer") if res.get("success") else "No matching FAQ found."

    if fn == "check_slots":
        from shared.tools import check_slots
        date = _resolve_date(args.get("date", ""))
        if not date:
            return (
                f"I couldn't understand the date '{args.get('date')}'. "
                "Please ask the customer to clarify — for example 'next Friday' or 'tomorrow'."
            )
        res = await check_slots(
            tenant_id=tenant_id,
            service_type=args.get("service_type", "general"),
            date=date,
            tenant_config=tenant,
        )
        if res.get("success") and res.get("available_slots"):
            slots = ", ".join(s["time"] for s in res["available_slots"][:8])
            return f"Available slots on {res['date']}: {slots}"
        return f"No available slots on {date.strftime('%Y-%m-%d')}."

    if fn == "book_appointment":
        from shared.tools import book_appointment, get_or_create_contact
        scheduled_at = _resolve_datetime(args.get("date", ""), args.get("time", ""))
        if not scheduled_at:
            date_val = args.get("date", "")
            time_val = args.get("time", "")
            return (
                f"I couldn't parse the date/time (date='{date_val}', time='{time_val}'). "
                "Please ask the customer to confirm the date and time, e.g. 'next Friday at 3pm'."
            )
        contact_result = await get_or_create_contact(
            tenant_id=tenant_id,
            phone=args.get("contact_phone", "test-0000"),
            name=args.get("contact_name", "Test User"),
            source="test",
        )
        if not contact_result.get("success"):
            return "Failed to create contact record."
        res = await book_appointment(
            tenant_id=tenant_id,
            contact_id=contact_result["contact"]["id"],
            contact_name=args.get("contact_name", ""),
            contact_phone=args.get("contact_phone", ""),
            service_type=args.get("service_type", ""),
            scheduled_at=scheduled_at,
            tenant_config=tenant,
            notes=args.get("notes"),
            source="test",
        )
        if res.get("success"):
            return (
                f"Appointment booked! ID: {res['booking_id']} — "
                f"{args.get('service_type')} on {scheduled_at.strftime('%A, %d %b %Y at %H:%M')}"
            )
        return f"Booking failed: {res.get('message') or res.get('error', 'unknown error')}"

    if fn == "cancel_appointment":
        from shared.tools import cancel_appointment
        res = await cancel_appointment(
            tenant_id=tenant_id,
            booking_id=args.get("booking_id"),
            contact_phone=args.get("contact_phone"),
        )
        if res.get("success"):
            return "Appointment cancelled successfully."
        return f"Cancellation failed: {res.get('message') or res.get('error', 'unknown error')}"

    if fn == "reschedule_appointment":
        from shared.tools import reschedule_appointment
        new_dt = _resolve_datetime(args.get("new_date", ""), args.get("new_time", ""))
        if not new_dt:
            return (
                f"Couldn't parse new date/time (date='{args.get('new_date')}', "
                f"time='{args.get('new_time')}'). Please ask the customer to clarify."
            )
        res = await reschedule_appointment(
            tenant_id=tenant_id,
            new_date=new_dt.strftime("%Y-%m-%d"),
            new_time=new_dt.strftime("%H:%M"),
            booking_id=args.get("booking_id"),
            contact_phone=args.get("contact_phone"),
        )
        if res.get("success"):
            new_time = res.get("new_time", new_dt.strftime("%A, %d %b %Y at %H:%M"))
            return f"Appointment rescheduled to {new_time}."
        return f"Reschedule failed: {res.get('message') or res.get('error', 'unknown error')}"

    if fn == "escalate_to_human":
        from shared.tools import escalate_to_human
        res = await escalate_to_human(
            tenant_id=tenant_id,
            reason=args.get("reason", ""),
            context="test-agent session",
            source="test",
        )
        return "Escalating to a human staff member." if res.get("success") else "Escalation logged."

    return f"[Tool '{fn}' not implemented]"


# ── Endpoint ───────────────────────────────────────────────────────────────────

@router.post("/test")
async def test_agent(req: TestMessage):
    tenant = await get_tenant_by_id(req.tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    if not tenant.system_prompt:
        raise HTTPException(status_code=400, detail="No system prompt configured. Set one in Agent Config first.")

    llm_client = load_llm_client(tenant)

    now = datetime.now()
    date_context = (
        f"\n\n[SYSTEM: Today is {now.strftime('%A, %d %B %Y')} "
        f"({now.strftime('%Y-%m-%d')}). "
        "When calling tools, always resolve natural-language dates (e.g. 'tomorrow', "
        "'next Friday', 'minggu depan', 'selasa depan') to the actual YYYY-MM-DD date "
        "before passing them to tools. Times like '3pm', '3 petang', '9 pagi' should be "
        "passed as HH:MM (24-hour). TEST MODE — all tools run for real.]"
    )

    conversation = list(req.history) + [{"role": "user", "content": req.message}]

    messages_payload = [
        {
            "role": "system",
            "content": tenant.system_prompt + date_context,
        },
        *conversation,
    ]

    enabled_tools = [
        t for t in TOOL_DEFINITIONS
        if tenant.tool_config.get(t["function"]["name"], True)
    ]

    try:
        response = await llm_client.generate(
            messages=messages_payload,
            tools=enabled_tools or None,
        )
    except Exception as e:
        logger.error(f"Agent test LLM error: {e}")
        raise HTTPException(status_code=502, detail=f"LLM error: {str(e)}")

    reply = response.get("content", "")
    tool_calls = response.get("tool_calls") or []
    tool_results = []

    for tc in tool_calls:
        fn = tc["function"]["name"]
        args = tc["function"]["arguments"]
        try:
            result_text = await _run_tool(fn, args, req.tenant_id, tenant)
        except Exception as e:
            logger.error(f"Tool '{fn}' error: {e}")
            result_text = f"Tool error: {str(e)}"

        tool_results.append({"tool": fn, "args": args, "result": result_text})
        if not reply:
            reply = result_text

    if not reply:
        reply = "I'm sorry, I couldn't process that. Please check your LLM configuration."

    updated_history = conversation + [{"role": "assistant", "content": reply}]

    return {
        "reply": reply,
        "tool_calls": tool_results,
        "history": updated_history,
        "provider": tenant.llm_config.get("provider", "unknown"),
        "model": tenant.llm_config.get("model", ""),
    }
