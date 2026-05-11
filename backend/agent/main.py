"""
LiveKit Voice Agent Worker — livekit-agents 1.3.x
Uses Agent + AgentSession with @function_tool pattern.
Tenant config and per-tenant API keys loaded from Supabase on every call.
"""

import asyncio
import os
import sys
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv
load_dotenv()

from livekit.agents import (
    Agent,
    AgentSession,
    AutoSubscribe,
    JobContext,
    RunContext,
    WorkerOptions,
    cli,
    function_tool,
)

from shared.tenant_config import get_tenant_by_sip_uri, get_supabase_client, TenantConfig
from shared.providers import load_tenant_providers, create_vad
from shared.tools import (
    book_appointment,
    check_slots,
    cancel_appointment,
    reschedule_appointment,
    get_faq,
    escalate_to_human,
    get_or_create_contact,
)
from shared.utils import (
    detect_language,
    parse_datetime,
    format_phone_number,
    check_emergency,
    check_escalation_request,
    logger,
)


# ── Per-call state passed via RunContext.userdata ──────────────────────────────

@dataclass
class CallState:
    tenant: TenantConfig
    contact: dict
    language: str
    turn_count: int = 0
    unclear_count: int = 0
    booking_count: int = 0
    escalated: bool = False
    call_start: datetime = None

    def __post_init__(self):
        if self.call_start is None:
            self.call_start = datetime.now()


# ── Tools (use RunContext.userdata to access per-call state) ──────────────────

@function_tool
async def tool_book_appointment(
    context: RunContext,
    contact_name: str,
    service_type: str,
    date: str,
    time: str,
    notes: Optional[str] = None,
) -> str:
    """
    Book an appointment for the patient.

    Args:
        contact_name: Patient's full name
        service_type: Type of service (e.g. scaling, checkup, whitening, extraction)
        date: Appointment date in YYYY-MM-DD format
        time: Appointment time in HH:MM 24-hour format
        notes: Optional extra notes for the appointment
    """
    state: CallState = context.userdata

    if state.booking_count >= 3:
        return "You've reached the maximum bookings for this call. Please call back for additional appointments."

    scheduled_dt = parse_datetime(date, time)
    if not scheduled_dt:
        return "I couldn't understand that date and time. Could you please repeat it?"

    result = await book_appointment(
        tenant_id=state.tenant.tenant_id,
        contact_id=state.contact["id"],
        contact_name=contact_name,
        contact_phone=state.contact.get("phone", ""),
        service_type=service_type,
        scheduled_at=scheduled_dt,
        tenant_config=state.tenant,
        notes=notes,
        source="voice",
    )

    if result["success"]:
        state.booking_count += 1
        cal = " It's also been added to the clinic calendar." if result.get("calendar_event_id") else ""
        return f"Done! Your {service_type} appointment is booked for {date} at {time}.{cal}"

    error = result.get("error", "")
    if error in ("double_booking", "rate_limit", "invalid_time"):
        return result["message"]

    return "I'm sorry, I couldn't complete the booking. Let me transfer you to someone who can help."


@function_tool
async def tool_check_slots(
    context: RunContext,
    date: str,
    service_type: Optional[str] = None,
) -> str:
    """
    Check available appointment slots for a date.

    Args:
        date: Date to check in YYYY-MM-DD format
        service_type: Optional service type for duration estimation
    """
    state: CallState = context.userdata

    try:
        date_obj = datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        return f"I couldn't understand the date '{date}'. Please use a format like 2025-06-15."

    result = await check_slots(
        tenant_id=state.tenant.tenant_id,
        service_type=service_type or "checkup",
        date=date_obj,
        tenant_config=state.tenant,
    )

    if result["success"] and result["available_slots"]:
        slots = ", ".join(s["time"] for s in result["available_slots"][:5])
        return f"Available times on {date}: {slots}. Which time works for you?"

    return f"No available slots on {date}. Would you like to check another date?"


@function_tool
async def tool_cancel_appointment(
    context: RunContext,
    booking_id: Optional[str] = None,
    contact_phone: Optional[str] = None,
) -> str:
    """
    Cancel an existing appointment.

    Args:
        booking_id: The booking ID to cancel (optional if contact_phone provided)
        contact_phone: Patient's phone number to find their latest pending appointment
    """
    state: CallState = context.userdata
    phone = contact_phone or state.contact.get("phone")

    result = await cancel_appointment(
        tenant_id=state.tenant.tenant_id,
        booking_id=booking_id,
        contact_phone=phone,
    )

    if result["success"]:
        scheduled = datetime.fromisoformat(result["scheduled_at"]).strftime("%B %d at %I:%M %p")
        return f"Done, your appointment on {scheduled} has been cancelled. Is there anything else I can help with?"

    if result.get("error") == "too_close":
        return result["message"]

    return "I couldn't find that appointment. Could you provide more details?"


@function_tool
async def tool_reschedule_appointment(
    context: RunContext,
    new_date: str,
    new_time: str,
    booking_id: Optional[str] = None,
    contact_phone: Optional[str] = None,
) -> str:
    """
    Reschedule an existing appointment to a new date and time.

    Args:
        new_date: New appointment date in YYYY-MM-DD format
        new_time: New appointment time in HH:MM 24-hour format
        booking_id: Booking ID (optional if contact_phone provided)
        contact_phone: Patient's phone number
    """
    state: CallState = context.userdata
    phone = contact_phone or state.contact.get("phone")

    result = await reschedule_appointment(
        tenant_id=state.tenant.tenant_id,
        new_date=new_date,
        new_time=new_time,
        booking_id=booking_id,
        contact_phone=phone,
    )

    if result["success"]:
        new = datetime.fromisoformat(result["new_time"]).strftime("%B %d at %I:%M %p")
        return f"Done! Your appointment has been rescheduled to {new}."

    return f"I couldn't reschedule that appointment. {result.get('error', '')}"


@function_tool
async def tool_get_faq(
    context: RunContext,
    question: str,
) -> str:
    """
    Search the clinic's FAQ for information about hours, services, location, or pricing.

    Args:
        question: The question to look up
    """
    state: CallState = context.userdata
    result = await get_faq(state.tenant, question)

    if result["success"]:
        return result["answer"]
    return "I don't have that information. Would you like me to connect you with someone who can help?"


@function_tool
async def tool_escalate_to_human(
    context: RunContext,
    reason: str,
) -> str:
    """
    Transfer the call to a human staff member.

    Args:
        reason: Brief reason for the transfer
    """
    state: CallState = context.userdata
    state.escalated = True

    await escalate_to_human(
        tenant_id=state.tenant.tenant_id,
        reason=reason,
        context="Tool-triggered escalation",
        source="voice",
    )
    return "Transferring you now. Please hold."


# ── Clinic Agent ───────────────────────────────────────────────────────────────

class ClinicAgent(Agent):
    """Tenant-specific voice agent with guardrail event hooks."""

    def __init__(self, tenant: TenantConfig, language: str):
        stt, agent_llm, tts = load_tenant_providers(tenant, language)

        super().__init__(
            instructions=tenant.system_prompt,
            stt=stt,
            llm=agent_llm,
            tts=tts,
            tools=[
                tool_book_appointment,
                tool_check_slots,
                tool_cancel_appointment,
                tool_reschedule_appointment,
                tool_get_faq,
                tool_escalate_to_human,
            ],
        )


# ── Entry point ────────────────────────────────────────────────────────────────

async def entrypoint(ctx: JobContext):
    logger.info(f"New call: room={ctx.room.name}")

    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    # Extract SIP destination from room metadata
    import json
    meta = ctx.room.metadata or "{}"
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except Exception:
            meta = {}

    sip_to = meta.get("sip_to", "")
    caller_number = meta.get("caller_number", "unknown")

    if not sip_to:
        logger.error("No sip_to in room metadata")
        return

    tenant = await get_tenant_by_sip_uri(sip_to)
    if not tenant or not tenant.is_active:
        logger.error(f"Unknown/inactive tenant for: {sip_to}")
        return

    logger.info(f"Tenant: {tenant.name} | caller: {caller_number}")

    # Get / create contact
    contact_result = await get_or_create_contact(
        tenant_id=tenant.tenant_id,
        phone=format_phone_number(caller_number),
        source="voice",
    )
    contact = contact_result.get("contact", {})
    language = contact.get("language_preference") or tenant.default_language

    # Per-call state accessible from all tools via RunContext.userdata
    state = CallState(tenant=tenant, contact=contact, language=language)

    session = AgentSession(userdata=state, vad=create_vad())

    # ── Guardrail event hooks ──────────────────────────────────────────────────
    @session.on("user_input_transcribed")
    def on_transcribed(ev):
        text = getattr(ev, "transcript", "") or ""
        state.turn_count += 1

        if not text.strip():
            state.unclear_count += 1
        else:
            state.unclear_count = 0

        # Language switch
        detected = detect_language(text)
        if detected != state.language:
            logger.info(f"Language switch: {state.language} → {detected}")
            state.language = detected

        if state.escalated:
            return

        if check_emergency(text):
            logger.info(f"Emergency keyword: {text[:60]}")
            asyncio.ensure_future(_emergency(session, tenant, state))
            return

        if check_escalation_request(text):
            logger.info(f"Escalation requested: {text[:60]}")
            asyncio.ensure_future(_human_requested(session, tenant, state))
            return

        if state.unclear_count >= 2:
            asyncio.ensure_future(_unclear(session, tenant, state))
            return

        if state.turn_count >= 10:
            asyncio.ensure_future(_max_turns(session, tenant, state))

    # Start session
    agent = ClinicAgent(tenant=tenant, language=language)
    await session.start(room=ctx.room, agent=agent)

    # Greeting
    greetings = {
        "en": f"Hello, you've reached {tenant.name}. How can I help you today?",
        "ms": f"Selamat datang ke {tenant.name}. Boleh saya bantu?",
        "zh": f"您好，欢迎致电{tenant.name}。请问有什么可以帮您？",
    }
    await session.generate_reply(
        instructions=greetings.get(language, greetings["en"])
    )

    try:
        await asyncio.sleep(3600)
    finally:
        await _save_call_log(tenant, contact, state)


# ── Guardrail actions ──────────────────────────────────────────────────────────

async def _emergency(session: AgentSession, tenant: TenantConfig, state: CallState):
    if state.escalated:
        return
    state.escalated = True
    await session.generate_reply(
        instructions="This sounds urgent. Let me connect you with our staff right away."
    )
    await escalate_to_human(tenant.tenant_id, "emergency", "Emergency keyword detected", "voice")


async def _human_requested(session: AgentSession, tenant: TenantConfig, state: CallState):
    if state.escalated:
        return
    state.escalated = True
    await session.generate_reply(
        instructions="Of course. Please hold while I connect you with someone."
    )
    await escalate_to_human(tenant.tenant_id, "user_requested", "Patient requested human", "voice")


async def _unclear(session: AgentSession, tenant: TenantConfig, state: CallState):
    if state.escalated:
        return
    state.escalated = True
    await session.generate_reply(
        instructions="I'm having trouble hearing you clearly. Let me transfer you to someone who can help."
    )
    await escalate_to_human(tenant.tenant_id, "unclear_audio", "2 consecutive unclear responses", "voice")


async def _max_turns(session: AgentSession, tenant: TenantConfig, state: CallState):
    if state.escalated:
        return
    state.escalated = True
    await session.generate_reply(
        instructions="I want to make sure you get the best help. Let me transfer you to someone on our team."
    )
    await escalate_to_human(tenant.tenant_id, "max_turns_reached", f"{state.turn_count} turns", "voice")


# ── Call log ───────────────────────────────────────────────────────────────────

async def _save_call_log(tenant: TenantConfig, contact: dict, state: CallState):
    try:
        supabase = get_supabase_client()
        duration = int((datetime.now() - state.call_start).total_seconds())

        flags = []
        if state.turn_count > 8:
            flags.append("long_conversation")
        if state.unclear_count > 1:
            flags.append("audio_issues")

        supabase.table("call_logs").insert({
            "tenant_id": tenant.tenant_id,
            "contact_id": contact.get("id"),
            "caller_number": contact.get("phone"),
            "duration_seconds": duration,
            "language_detected": state.language,
            "turn_count": state.turn_count,
            "auto_escalated": state.escalated,
            "escalation_reason": flags[0] if flags else None,
            "stt_provider": tenant.stt_config.get(state.language, "deepgram"),
            "llm_provider": tenant.llm_config.get("provider", "openai"),
            "tts_provider": tenant.tts_config.get(state.language, "cartesia"),
            "started_at": state.call_start.isoformat(),
            "ended_at": datetime.now().isoformat(),
        }).execute()

        logger.info(f"Call log saved | duration={duration}s turns={state.turn_count}")
    except Exception as e:
        logger.error(f"Failed to save call log: {e}")


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
