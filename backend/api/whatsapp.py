"""
WhatsApp Webhook Handlers (Meta Cloud API)
Handles incoming messages from clinic WhatsApp Business numbers.
Integrates guardrails: emergency detection, escalation phrases, human-takeover mode.
"""

import sys
import os
from datetime import datetime

import httpx
from fastapi import APIRouter, Request, HTTPException, Response

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.tenant_config import get_tenant_by_wa_phone_id, get_supabase_client
from shared.providers import load_llm_client
from shared.tools import (
    book_appointment,
    check_slots,
    cancel_appointment,
    reschedule_appointment,
    get_faq,
    escalate_to_human,
    get_or_create_contact,
    TOOL_DEFINITIONS,
)
from shared.utils import (
    detect_language,
    parse_datetime,
    format_phone_number,
    check_emergency,
    check_escalation_request,
    logger,
)

router = APIRouter()


# ── Webhook verification ───────────────────────────────────────────────────────

@router.get("/whatsapp/{tenant_id}")
async def whatsapp_verify(tenant_id: str, request: Request):
    """Meta webhook verification (called once during setup)."""
    mode = request.query_params.get("hub.mode")
    token = request.query_params.get("hub.verify_token")
    challenge = request.query_params.get("hub.challenge")

    if mode == "subscribe":
        supabase = get_supabase_client()
        tenant = supabase.table("tenants").select("wa_verify_token").eq(
            "id", tenant_id
        ).single().execute()

        if tenant.data and tenant.data.get("wa_verify_token") == token:
            return Response(content=challenge, media_type="text/plain")

    raise HTTPException(status_code=403, detail="Verification failed")


# ── Incoming message webhook ───────────────────────────────────────────────────

@router.post("/whatsapp/{tenant_id}")
async def whatsapp_webhook(tenant_id: str, request: Request):
    """Meta webhook for incoming WhatsApp messages."""
    try:
        payload = await request.json()

        entry = payload.get("entry", [{}])[0]
        changes = entry.get("changes", [{}])[0]
        value = changes.get("value", {})

        messages = value.get("messages", [])
        if not messages:
            return {"status": "no_messages"}

        message = messages[0]
        phone_number_id = value.get("metadata", {}).get("phone_number_id")

        if not phone_number_id:
            raise HTTPException(status_code=400, detail="Missing phone_number_id")

        tenant = await get_tenant_by_wa_phone_id(phone_number_id)
        if not tenant or not tenant.is_active:
            logger.warning(f"Unknown tenant for phone_number_id: {phone_number_id}")
            return {"status": "unknown_tenant"}

        await handle_whatsapp_message(tenant, message, value)
        return {"status": "ok"}

    except Exception as e:
        logger.error(f"WhatsApp webhook error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Message handler ────────────────────────────────────────────────────────────

async def handle_whatsapp_message(tenant, message: dict, value: dict):
    supabase = get_supabase_client()

    from_number = message.get("from")
    if message.get("type") != "text":
        return

    message_text = message.get("text", {}).get("body", "")
    if not message_text:
        return

    language = detect_language(message_text)
    formatted_phone = format_phone_number(from_number)

    # Get or create contact
    contact_result = await get_or_create_contact(
        tenant_id=tenant.tenant_id,
        phone=formatted_phone,
        source="whatsapp",
    )
    contact = contact_result.get("contact", {})

    # Load / create thread
    thread_result = supabase.table("whatsapp_threads").select("*").eq(
        "tenant_id", tenant.tenant_id
    ).eq("contact_number", formatted_phone).execute()

    if thread_result.data:
        thread = thread_result.data[0]
        # Human-takeover mode: save message silently, don't reply
        if thread.get("status") == "human_takeover":
            supabase.table("messages").insert({
                "thread_id": thread["id"],
                "tenant_id": tenant.tenant_id,
                "contact_id": contact.get("id"),
                "wa_message_id": message.get("id"),
                "role": "user",
                "body": message_text,
                "language": language,
                "handled_by": "human",
            }).execute()
            return
    else:
        new_thread = supabase.table("whatsapp_threads").insert({
            "tenant_id": tenant.tenant_id,
            "contact_id": contact.get("id"),
            "contact_number": formatted_phone,
            "contact_name": contact.get("name"),
            "language": language,
            "status": "ai",
            "last_message_at": datetime.now().isoformat(),
        }).execute()
        thread = new_thread.data[0]

    # ── Guardrails ─────────────────────────────────────────────────────────────
    if check_emergency(message_text):
        logger.info(f"WA emergency keyword | tenant={tenant.tenant_id}")
        await _handle_wa_escalation(
            tenant, thread, contact, from_number,
            reason="emergency",
            reply="This sounds urgent. I'm connecting you with our staff right away.",
            supabase=supabase,
        )
        return

    if check_escalation_request(message_text):
        logger.info(f"WA escalation request | tenant={tenant.tenant_id}")
        await _handle_wa_escalation(
            tenant, thread, contact, from_number,
            reason="user_requested",
            reply="Of course! I'll connect you with someone now. Please give us a moment.",
            supabase=supabase,
        )
        return

    # Load last 10 messages for context
    history_result = supabase.table("messages").select("role, body").eq(
        "thread_id", thread["id"]
    ).order("created_at", desc=False).limit(10).execute()

    conversation_history = [
        {"role": m["role"], "content": m["body"]} for m in history_result.data
    ]
    conversation_history.append({"role": "user", "content": message_text})

    # Save user message
    supabase.table("messages").insert({
        "thread_id": thread["id"],
        "tenant_id": tenant.tenant_id,
        "contact_id": contact.get("id"),
        "wa_message_id": message.get("id"),
        "role": "user",
        "body": message_text,
        "language": language,
        "handled_by": "ai",
    }).execute()

    # Build LLM client using tenant's own API keys
    llm_client = load_llm_client(tenant)

    messages_payload = [
        {
            "role": "system",
            "content": tenant.system_prompt + "\n\nYou are responding via WhatsApp. Keep replies concise (under 3 sentences).",
        },
        *conversation_history,
    ]

    enabled_tools = [
        t for t in TOOL_DEFINITIONS
        if tenant.tool_config.get(t["function"]["name"], True)
    ]

    response = await llm_client.generate(
        messages=messages_payload,
        tools=enabled_tools or None,
    )

    # Execute tool calls if any
    reply_text = response.get("content", "")
    if response.get("tool_calls"):
        reply_text = await _execute_wa_tools(
            response["tool_calls"], tenant, contact, language
        )

    if not reply_text:
        reply_text = "I'm sorry, I couldn't process that. Please try again or call us directly."

    # Send reply
    await send_whatsapp_message(
        to=from_number,
        text=reply_text,
        phone_number_id=tenant.wa_phone_number_id,
        access_token=tenant.wa_access_token,
    )

    # Save assistant message
    supabase.table("messages").insert({
        "thread_id": thread["id"],
        "tenant_id": tenant.tenant_id,
        "contact_id": contact.get("id"),
        "role": "assistant",
        "body": reply_text,
        "language": language,
        "handled_by": "ai",
    }).execute()

    supabase.table("whatsapp_threads").update({
        "last_message_at": datetime.now().isoformat(),
        "language": language,
    }).eq("id", thread["id"]).execute()


async def _execute_wa_tools(tool_calls: list, tenant, contact: dict, language: str) -> str:
    """Execute LLM tool calls and return a combined response string."""
    results = []

    for tc in tool_calls:
        fn_name = tc["function"]["name"]
        args = tc["function"]["arguments"]

        if fn_name == "book_appointment":
            scheduled_dt = parse_datetime(args.get("date", ""), args.get("time", ""))
            if not scheduled_dt:
                results.append("I couldn't understand the date and time. Please try again with YYYY-MM-DD and HH:MM format.")
                continue
            result = await book_appointment(
                tenant_id=tenant.tenant_id,
                contact_id=contact.get("id"),
                contact_name=args.get("contact_name", contact.get("name", "Patient")),
                contact_phone=args.get("contact_phone", contact.get("phone", "")),
                service_type=args.get("service_type", ""),
                scheduled_at=scheduled_dt,
                tenant_config=tenant,
                notes=args.get("notes"),
                source="whatsapp",
            )
            if result["success"]:
                results.append(
                    f"Done! Your {args.get('service_type')} appointment is booked for "
                    f"{args.get('date')} at {args.get('time')}."
                )
            else:
                results.append(result.get("message", "Sorry, I couldn't complete that booking."))

        elif fn_name == "check_slots":
            try:
                date_obj = datetime.strptime(args["date"], "%Y-%m-%d")
            except (ValueError, KeyError):
                results.append("Please provide the date in YYYY-MM-DD format.")
                continue
            result = await check_slots(
                tenant_id=tenant.tenant_id,
                service_type=args.get("service_type", "checkup"),
                date=date_obj,
                tenant_config=tenant,
            )
            if result["success"] and result["available_slots"]:
                slots = ", ".join(s["time"] for s in result["available_slots"][:5])
                results.append(f"Available times on {args['date']}: {slots}")
            else:
                results.append(f"No available slots on {args['date']}.")

        elif fn_name == "cancel_appointment":
            result = await cancel_appointment(
                tenant_id=tenant.tenant_id,
                booking_id=args.get("booking_id"),
                contact_phone=args.get("contact_phone") or contact.get("phone"),
            )
            if result["success"]:
                from datetime import datetime as dt
                t = dt.fromisoformat(result["scheduled_at"]).strftime("%B %d at %I:%M %p")
                results.append(f"Your appointment on {t} has been cancelled.")
            else:
                results.append(result.get("message", "I couldn't find that appointment."))

        elif fn_name == "reschedule_appointment":
            result = await reschedule_appointment(
                tenant_id=tenant.tenant_id,
                new_date=args.get("new_date", ""),
                new_time=args.get("new_time", ""),
                booking_id=args.get("booking_id"),
                contact_phone=args.get("contact_phone") or contact.get("phone"),
            )
            if result["success"]:
                from datetime import datetime as dt
                new = dt.fromisoformat(result["new_time"]).strftime("%B %d at %I:%M %p")
                results.append(f"Rescheduled! Your new appointment is on {new}.")
            else:
                results.append(result.get("error", "Couldn't reschedule that appointment."))

        elif fn_name == "get_faq":
            result = await get_faq(tenant, args.get("question", ""))
            if result["success"]:
                results.append(result["answer"])
            else:
                results.append("I don't have that information. Please contact us directly.")

        elif fn_name == "escalate_to_human":
            await escalate_to_human(
                tenant_id=tenant.tenant_id,
                reason=args.get("reason", "user_requested"),
                context="WA tool escalation",
                source="whatsapp",
            )
            results.append("I'm connecting you with one of our staff members now. They'll be in touch shortly.")

    return " ".join(results) if results else ""


async def _handle_wa_escalation(
    tenant, thread: dict, contact: dict, from_number: str,
    reason: str, reply: str, supabase,
):
    """Mark thread as human-takeover, log escalation, send reply."""
    supabase.table("whatsapp_threads").update({"status": "human_takeover"}).eq(
        "id", thread["id"]
    ).execute()

    await escalate_to_human(
        tenant_id=tenant.tenant_id,
        reason=reason,
        context=f"WhatsApp escalation — thread {thread['id']}",
        source="whatsapp",
    )

    await send_whatsapp_message(
        to=from_number,
        text=reply,
        phone_number_id=tenant.wa_phone_number_id,
        access_token=tenant.wa_access_token,
    )


# ── Meta send helper ───────────────────────────────────────────────────────────

async def send_whatsapp_message(to: str, text: str, phone_number_id: str, access_token: str):
    """Send a WhatsApp text message via Meta Cloud API v18."""
    url = f"https://graph.facebook.com/v18.0/{phone_number_id}/messages"
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.post(
            url,
            json={
                "messaging_product": "whatsapp",
                "to": to,
                "type": "text",
                "text": {"body": text},
            },
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
        )
        response.raise_for_status()
        return response.json()
