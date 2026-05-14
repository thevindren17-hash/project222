"""
Agent Test Endpoint
Lets the dashboard owner chat with the AI agent using their live config.
All tools run for real in test mode so the full flow can be verified.
"""

from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from shared.tenant_config import get_tenant_by_id
from shared.providers import load_llm_client
from shared.tools import TOOL_DEFINITIONS, get_faq
from shared.utils import logger, parse_datetime

router = APIRouter()


class TestMessage(BaseModel):
    tenant_id: str
    message: str
    history: list = []


def _resolve_date(date_str: str) -> Optional[datetime]:
    """Parse date string including relative values like 'today' and 'tomorrow'."""
    s = date_str.lower().strip()
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    if s in ("today", "today's date"):
        return today
    if s in ("tomorrow", "tomorrow's date", "tmr"):
        return today + timedelta(days=1)
    # Try YYYY-MM-DD and other standard formats
    result = parse_datetime(s, "00:00")
    return result.replace(hour=0, minute=0, second=0, microsecond=0) if result else None


def _resolve_datetime(date_str: str, time_str: str) -> Optional[datetime]:
    """Parse date + time, supporting relative date strings."""
    date = _resolve_date(date_str)
    if not date:
        return None
    try:
        parts = time_str.strip().split(":")
        return date.replace(hour=int(parts[0]), minute=int(parts[1]) if len(parts) > 1 else 0)
    except Exception:
        return None


async def _run_tool(fn: str, args: dict, tenant_id: str, tenant) -> str:
    """Execute a single tool and return a human-readable result string."""

    if fn == "get_faq":
        res = await get_faq(tenant, args.get("question", ""))
        return res.get("answer") if res.get("success") else "No matching FAQ found."

    if fn == "check_slots":
        from shared.tools import check_slots
        date = _resolve_date(args.get("date", ""))
        if not date:
            return "Could not parse date. Please use YYYY-MM-DD format."
        res = await check_slots(
            tenant_id=tenant_id,
            service_type=args.get("service_type", "general"),
            date=date,
            tenant_config=tenant,
        )
        if res.get("success") and res.get("available_slots"):
            slots = ", ".join(s["time"] for s in res["available_slots"][:8])
            return f"Available slots on {res['date']}: {slots}"
        return f"No available slots on {args.get('date')}."

    if fn == "book_appointment":
        from shared.tools import book_appointment, get_or_create_contact
        scheduled_at = _resolve_datetime(args.get("date", ""), args.get("time", ""))
        if not scheduled_at:
            return "Could not parse date/time. Please use YYYY-MM-DD and HH:MM format."
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
            return f"Appointment booked! ID: {res['booking_id']} — {args.get('service_type')} on {scheduled_at.strftime('%Y-%m-%d at %H:%M')}"
        return f"Booking failed: {res.get('message') or res.get('error', 'unknown error')}"

    if fn == "cancel_appointment":
        from shared.tools import cancel_appointment
        res = await cancel_appointment(
            tenant_id=tenant_id,
            booking_id=args.get("booking_id"),
            contact_phone=args.get("contact_phone"),
        )
        if res.get("success"):
            return f"Appointment cancelled successfully."
        return f"Cancellation failed: {res.get('message') or res.get('error', 'unknown error')}"

    if fn == "reschedule_appointment":
        from shared.tools import reschedule_appointment
        res = await reschedule_appointment(
            tenant_id=tenant_id,
            new_date=args.get("new_date", ""),
            new_time=args.get("new_time", ""),
            booking_id=args.get("booking_id"),
            contact_phone=args.get("contact_phone"),
        )
        if res.get("success"):
            new_time = res.get("new_time", "")
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


@router.post("/test")
async def test_agent(req: TestMessage):
    tenant = await get_tenant_by_id(req.tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    if not tenant.system_prompt:
        raise HTTPException(status_code=400, detail="No system prompt configured. Set one in Agent Config first.")

    llm_client = load_llm_client(tenant)

    conversation = list(req.history) + [{"role": "user", "content": req.message}]

    messages_payload = [
        {
            "role": "system",
            "content": tenant.system_prompt
                + "\n\n[TEST MODE — all tools are active and run for real. Bookings will be saved to the database.]",
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
