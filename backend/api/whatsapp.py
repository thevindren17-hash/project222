"""
WhatsApp Webhook Handlers (Meta Cloud API)
Handles incoming messages from clinic WhatsApp Business numbers.
Integrates guardrails: emergency detection, escalation phrases, human-takeover mode.
"""

import sys
import os
import re
import json
from datetime import datetime, timedelta

import httpx
from fastapi import APIRouter, Request, HTTPException, Response

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.tenant_config import get_tenant_by_wa_phone_id, get_tenant_by_id, get_supabase_client
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

def _derive_verify_token(tenant_id: str) -> str:
    """Deterministic verify token derived from tenant ID — no DB save needed."""
    return f"wa_{tenant_id.replace('-', '')[:16]}"


@router.get("/whatsapp/{tenant_id}")
async def whatsapp_verify(tenant_id: str, request: Request):
    """Meta webhook verification — token is derived from tenant ID, no prior save needed."""
    mode = request.query_params.get("hub.mode")
    token = request.query_params.get("hub.verify_token")
    challenge = request.query_params.get("hub.challenge")

    if mode == "subscribe" and token == _derive_verify_token(tenant_id):
        return Response(content=challenge, media_type="text/plain")

    raise HTTPException(status_code=403, detail="Verification failed")


# ── Incoming message webhook ───────────────────────────────────────────────────

@router.post("/whatsapp/{tenant_id}")
async def whatsapp_webhook(tenant_id: str, request: Request):
    """Meta webhook for incoming WhatsApp messages.
    MUST always return 200 — any non-200 causes Meta to retry endlessly.
    """
    try:
        payload = await request.json()
    except Exception:
        return {"status": "invalid_json"}

    try:
        entry = payload.get("entry", [{}])[0]
        changes = entry.get("changes", [{}])[0]
        value = changes.get("value", {})

        messages = value.get("messages", [])
        if not messages:
            return {"status": "no_messages"}

        message = messages[0]
        wa_message_id = message.get("id", "")

        # Deduplication — skip if we've already processed this exact message
        supabase = get_supabase_client()
        if wa_message_id:
            already = supabase.table("messages").select("id").eq(
                "wa_message_id", wa_message_id
            ).limit(1).execute()
            if already.data:
                logger.info(f"Duplicate WA message skipped: {wa_message_id}")
                return {"status": "duplicate"}

        tenant = await get_tenant_by_id(tenant_id)
        if not tenant or not tenant.is_active:
            logger.warning(f"Unknown or inactive tenant: {tenant_id}")
            return {"status": "unknown_tenant"}

        # Guard: can't reply without send credentials
        if not tenant.wa_phone_number_id or not tenant.wa_access_token:
            logger.warning(f"Tenant {tenant_id} missing WA credentials — cannot reply")
            return {"status": "no_credentials"}

        await handle_whatsapp_message(tenant, message, value)
        return {"status": "ok"}

    except Exception as e:
        # Log but always return 200 so Meta doesn't retry
        logger.error(f"WhatsApp webhook error: {e}", exc_info=True)
        return {"status": "error", "detail": str(e)}


# ── Message handler ────────────────────────────────────────────────────────────

async def _download_wa_media(media_id: str, access_token: str) -> bytes:
    """Download a media file from WhatsApp Cloud API."""
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(
            f"https://graph.facebook.com/v21.0/{media_id}",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        r.raise_for_status()
        media_url = r.json().get("url")
        if not media_url:
            raise ValueError("No media URL returned from Meta")
        r2 = await client.get(media_url, headers={"Authorization": f"Bearer {access_token}"})
        r2.raise_for_status()
        return r2.content


async def _transcribe_audio(audio_bytes: bytes, provider: str, tenant) -> str:
    """Transcribe audio using STT. Returns transcript text."""
    from shared.providers import _cred
    import io

    if provider == "deepgram":
        api_key = _cred(tenant, "deepgram", "api_key")
        if not api_key:
            raise ValueError("No Deepgram API key")
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true",
                headers={"Authorization": f"Token {api_key}", "Content-Type": "audio/ogg"},
                content=audio_bytes,
            )
            r.raise_for_status()
            body = r.json()
            alternatives = body.get("results", {}).get("channels", [{}])[0].get("alternatives", [])
            return alternatives[0].get("transcript", "") if alternatives else ""

    # Default: OpenAI Whisper
    from openai import AsyncOpenAI
    from shared.providers import _cred
    api_key = _cred(tenant, "openai", "api_key")
    if not api_key:
        raise ValueError("No OpenAI API key for transcription")
    client = AsyncOpenAI(api_key=api_key)
    audio_file = io.BytesIO(audio_bytes)
    audio_file.name = "audio.ogg"
    transcript = await client.audio.transcriptions.create(model="whisper-1", file=audio_file)
    return transcript.text


async def _generate_tts_ogg(text: str, voice: str, tenant) -> bytes:
    """Generate speech as OGG Opus using OpenAI TTS."""
    from openai import AsyncOpenAI
    from shared.providers import _cred
    api_key = _cred(tenant, "openai", "api_key")
    if not api_key:
        raise ValueError("No OpenAI API key for TTS")
    client = AsyncOpenAI(api_key=api_key)
    response = await client.audio.speech.create(
        model="tts-1",
        voice=voice or "nova",
        input=text,
        response_format="opus",
    )
    return response.content


async def _upload_wa_media(audio_bytes: bytes, phone_number_id: str, access_token: str) -> str:
    """Upload audio to WhatsApp and return media_id."""
    import io
    url = f"https://graph.facebook.com/v21.0/{phone_number_id}/media"
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            url,
            headers={"Authorization": f"Bearer {access_token}"},
            data={"messaging_product": "whatsapp", "type": "audio/ogg"},
            files={"file": ("voice.ogg", io.BytesIO(audio_bytes), "audio/ogg; codecs=opus")},
        )
        r.raise_for_status()
        return r.json()["id"]


async def _send_whatsapp_audio(to: str, media_id: str, phone_number_id: str, access_token: str):
    """Send a WhatsApp voice note via media ID."""
    url = f"https://graph.facebook.com/v21.0/{phone_number_id}/messages"
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            url,
            json={
                "messaging_product": "whatsapp",
                "to": to,
                "type": "audio",
                "audio": {"id": media_id},
            },
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        )
        r.raise_for_status()


def _parse_embedded_tool_calls(text: str):
    """
    Some models (Llama/Groq) embed tool calls as <function=NAME>JSON</function> in text.
    Returns (cleaned_text, list_of_tool_call_dicts).
    """
    tool_calls = []

    def _replacer(m):
        fn_name = m.group(1)
        try:
            args = json.loads(m.group(2).strip())
        except Exception:
            args = {}
        tool_calls.append({"function": {"name": fn_name, "arguments": args}})
        return ""

    cleaned = re.sub(
        r"<function=([^>]+)>(.*?)</function>",
        _replacer,
        text,
        flags=re.DOTALL,
    ).strip()
    return cleaned, tool_calls


def _build_date_context(reply_language: str = "ask", is_new_conversation: bool = False) -> str:
    now = datetime.now()
    tomorrow = now + timedelta(days=1)

    if reply_language == "en":
        lang_rule = "STRICT LANGUAGE RULE: You MUST always reply in English only, no matter what language the user writes in."
    elif reply_language == "ms":
        lang_rule = "PERATURAN BAHASA KETAT: Anda MESTI sentiasa membalas dalam Bahasa Melayu sahaja, tidak kira apa bahasa yang digunakan oleh pengguna."
    elif reply_language == "zh":
        lang_rule = "严格语言规则：无论用户使用什么语言，您必须始终只用中文回复。"
    else:
        # "ask" mode
        if is_new_conversation:
            lang_rule = (
                "LANGUAGE RULE: This is the very first message. Before doing anything else, greet the user "
                "and ask which language they prefer: English, Bahasa Melayu, or Chinese (Mandarin). "
                "Example: 'Hello! Would you prefer to chat in English, Bahasa Melayu, or Chinese?' "
                "Do NOT proceed with any other response until the user confirms their language."
            )
        else:
            lang_rule = (
                "LANGUAGE RULE: Check the conversation history to see which language the user chose. "
                "Use that language consistently. If no preference was stated, match whatever language "
                "the user is writing in right now. Never mix languages in one reply."
            )

    return (
        f"\n\n[SYSTEM INFO — Today is {now.strftime('%A, %d %B %Y')} ({now.strftime('%Y-%m-%d')}). "
        f"Tomorrow is {tomorrow.strftime('%A, %Y-%m-%d')}.\n"
        f"{lang_rule}\n"
        "BOOKING FLOW — follow these steps strictly, one question per message:\n"
        "  Step 1: Ask what SERVICE they need (e.g. scaling, checkup, whitening). Do NOT skip this.\n"
        "  Step 2: Ask what DATE they prefer. Do NOT skip this.\n"
        "  Step 3: ONLY after you have BOTH service AND date → call check_slots.\n"
        "  Step 4: Present the available times clearly. Ask which time they prefer.\n"
        "  Step 5: If user replies with a number like '10' or '10am', treat it as the time (e.g. 10:00). Do NOT call check_slots again.\n"
        "  Step 6: Ask for their NAME (if not already given in this conversation).\n"
        "  Step 7: Ask for their PHONE NUMBER (if not already given).\n"
        "  Step 8: Confirm: service, date, time, name, phone — then call book_appointment.\n"
        "HARD RULES:\n"
        "- NEVER call check_slots unless you already know the specific date the user wants.\n"
        "- NEVER call book_appointment unless you have all 5: name, phone, service, date, time.\n"
        "- NEVER re-ask for info already given earlier in this conversation.\n"
        "- When user picks a time from the shown list, proceed to collect name/phone — do not show slots again.\n"
        "- Date/time: 'esok'/'tomorrow' → exact date above, '3pm'/'3 petang' → 15:00, '9am' → 09:00, '10' after seeing slots → 10:00.\n"
        "- Always pass real values to tools — never pass placeholder text.\n"
        "You are on WhatsApp. Keep replies concise — one question at a time, under 2 sentences.]"
    )


async def handle_whatsapp_message(tenant, message: dict, value: dict):
    supabase = get_supabase_client()

    from_number = message.get("from")
    msg_type = message.get("type", "text")

    # Handle audio (voice note)
    if msg_type == "audio":
        audio_info = message.get("audio", {})
        media_id = audio_info.get("id")
        if media_id:
            await _handle_voice_message(tenant, message, from_number, media_id, supabase)
        return

    if msg_type != "text":
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

    # Load last 20 messages for context
    history_result = supabase.table("messages").select("role, body").eq(
        "thread_id", thread["id"]
    ).order("created_at", desc=False).limit(20).execute()

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
    is_new_conversation = len(conversation_history) == 1
    date_context = _build_date_context(
        reply_language=getattr(tenant, "reply_language", "ask"),
        is_new_conversation=is_new_conversation,
    )

    messages_payload = [
        {
            "role": "system",
            "content": tenant.system_prompt + date_context,
        },
        *conversation_history,
    ]

    enabled_tools = [
        t for t in TOOL_DEFINITIONS
        if tenant.tool_config.get(t["function"]["name"], True)
    ]

    # Once slots have been shown, remove check_slots so the model cannot call it again.
    # The user's next reply is a time selection — only book_appointment is needed.
    _SLOT_MARKERS = ("available times", "masa yang tersedia", "可用时间", "available slot")
    slots_already_shown = any(
        any(marker in m["body"].lower() for marker in _SLOT_MARKERS)
        for m in history_result.data
        if m["role"] == "assistant"
    )
    if slots_already_shown:
        enabled_tools = [t for t in enabled_tools if t["function"]["name"] != "check_slots"]

    response = await llm_client.generate(
        messages=messages_payload,
        tools=enabled_tools or None,
    )

    # Execute tool calls if any
    reply_text = response.get("content", "")
    tool_calls = response.get("tool_calls")

    # Some models (Llama/Groq) embed tool calls as text tags instead of structured calls
    if not tool_calls and reply_text and "<function=" in reply_text:
        reply_text, tool_calls = _parse_embedded_tool_calls(reply_text)

    if tool_calls:
        tool_result = await _execute_wa_tools(tool_calls, tenant, contact, language)
        if tool_result:
            reply_text = f"{reply_text}\n\n{tool_result}".strip() if reply_text else tool_result

    if not reply_text:
        reply_text = "I'm sorry, I couldn't process that. Please try again or call us directly."

    # Save assistant message FIRST — so the dashboard always shows what the AI said,
    # even if the WhatsApp send step fails below
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

    # Now send to WhatsApp — log exact Meta error if it fails
    try:
        await send_whatsapp_message(
            to=from_number,
            text=reply_text,
            phone_number_id=tenant.wa_phone_number_id,
            access_token=tenant.wa_access_token,
        )
        logger.info(f"Reply sent OK to={from_number} tenant={tenant.tenant_id}")
    except Exception as send_err:
        logger.error(
            f"SEND FAILED | tenant={tenant.tenant_id} | to={from_number} | "
            f"phone_id={tenant.wa_phone_number_id} | error={send_err}"
        )


async def _handle_voice_message(tenant, message: dict, from_number: str, media_id: str, supabase):
    """Handle incoming WhatsApp voice note: transcribe → LLM → optional voice reply."""
    language = "en"
    formatted_phone = format_phone_number(from_number)

    contact_result = await get_or_create_contact(
        tenant_id=tenant.tenant_id, phone=formatted_phone, source="whatsapp"
    )
    contact = contact_result.get("contact", {})

    thread_result = supabase.table("whatsapp_threads").select("*").eq(
        "tenant_id", tenant.tenant_id
    ).eq("contact_number", formatted_phone).execute()

    if thread_result.data:
        thread = thread_result.data[0]
        if thread.get("status") == "human_takeover":
            # Store voice note as-is during human takeover
            supabase.table("messages").insert({
                "thread_id": thread["id"], "tenant_id": tenant.tenant_id,
                "contact_id": contact.get("id"), "wa_message_id": message.get("id"),
                "role": "user", "body": "[Voice message]",
                "language": language, "handled_by": "human",
            }).execute()
            return
    else:
        new_thread = supabase.table("whatsapp_threads").insert({
            "tenant_id": tenant.tenant_id, "contact_id": contact.get("id"),
            "contact_number": formatted_phone, "language": language,
            "status": "ai", "last_message_at": datetime.now().isoformat(),
        }).execute()
        thread = new_thread.data[0]

    # Transcribe
    try:
        audio_bytes = await _download_wa_media(media_id, tenant.wa_access_token)
        stt_provider = getattr(tenant, "voice_stt_provider", None) or "openai"
        transcript = await _transcribe_audio(audio_bytes, stt_provider, tenant)
        if not transcript.strip():
            transcript = "[Could not transcribe voice message]"
    except Exception as e:
        logger.error(f"STT error: {e}")
        await send_whatsapp_message(
            to=from_number, text="Sorry, I couldn't understand that voice message. Please try sending a text message.",
            phone_number_id=tenant.wa_phone_number_id, access_token=tenant.wa_access_token,
        )
        return

    language = detect_language(transcript)

    # Get conversation history BEFORE saving the current message (avoids duplicate in LLM payload)
    history = supabase.table("messages").select("role, body").eq(
        "thread_id", thread["id"]
    ).order("created_at", desc=False).limit(20).execute()
    conversation_history = [{"role": m["role"], "content": m["body"]} for m in history.data]
    conversation_history.append({"role": "user", "content": transcript})

    # Save transcribed user voice message
    supabase.table("messages").insert({
        "thread_id": thread["id"], "tenant_id": tenant.tenant_id,
        "contact_id": contact.get("id"), "wa_message_id": message.get("id"),
        "role": "user", "body": transcript,
        "language": language, "handled_by": "ai",
    }).execute()

    # LLM response
    llm_client = load_llm_client(tenant)
    is_new_conversation = len(conversation_history) == 1
    date_context = _build_date_context(
        reply_language=getattr(tenant, "reply_language", "ask"),
        is_new_conversation=is_new_conversation,
    )
    messages_payload = [
        {"role": "system", "content": tenant.system_prompt + date_context},
        *conversation_history,
    ]
    enabled_tools = [t for t in TOOL_DEFINITIONS if tenant.tool_config.get(t["function"]["name"], True)]
    _SLOT_MARKERS = ("available times", "masa yang tersedia", "可用时间", "available slot")
    slots_already_shown = any(
        any(marker in m["body"].lower() for marker in _SLOT_MARKERS)
        for m in history.data
        if m["role"] == "assistant"
    )
    if slots_already_shown:
        enabled_tools = [t for t in enabled_tools if t["function"]["name"] != "check_slots"]
    response = await llm_client.generate(messages=messages_payload, tools=enabled_tools or None)

    reply_text = response.get("content", "")
    tool_calls = response.get("tool_calls")

    if not tool_calls and reply_text and "<function=" in reply_text:
        reply_text, tool_calls = _parse_embedded_tool_calls(reply_text)

    if tool_calls:
        tool_result = await _execute_wa_tools(tool_calls, tenant, contact, language)
        if tool_result:
            reply_text = f"{reply_text}\n\n{tool_result}".strip() if reply_text else tool_result

    if not reply_text:
        reply_text = "I'm sorry, I couldn't process that. Please try again."

    # Send reply: voice if enabled, otherwise text
    voice_enabled = getattr(tenant, "voice_reply_enabled", False)
    tts_voice = getattr(tenant, "voice_tts_voice", "nova") or "nova"

    if voice_enabled:
        try:
            ogg_bytes = await _generate_tts_ogg(reply_text, tts_voice, tenant)
            media_id_reply = await _upload_wa_media(ogg_bytes, tenant.wa_phone_number_id, tenant.wa_access_token)
            await _send_whatsapp_audio(
                to=from_number, media_id=media_id_reply,
                phone_number_id=tenant.wa_phone_number_id, access_token=tenant.wa_access_token,
            )
        except Exception as e:
            logger.warning(f"Voice reply failed, falling back to text: {e}")
            await send_whatsapp_message(
                to=from_number, text=reply_text,
                phone_number_id=tenant.wa_phone_number_id, access_token=tenant.wa_access_token,
            )
    else:
        try:
            await send_whatsapp_message(
                to=from_number, text=f"🎤 _{transcript}_\n\n{reply_text}",
                phone_number_id=tenant.wa_phone_number_id, access_token=tenant.wa_access_token,
            )
        except Exception as send_err:
            logger.error(f"SEND FAILED (voice) tenant={tenant.tenant_id} to={from_number}: {send_err}")
            return

    # Save assistant message
    supabase.table("messages").insert({
        "thread_id": thread["id"], "tenant_id": tenant.tenant_id,
        "contact_id": contact.get("id"), "role": "assistant", "body": reply_text,
        "language": language, "handled_by": "ai",
    }).execute()

    supabase.table("whatsapp_threads").update({
        "last_message_at": datetime.now().isoformat(), "language": language,
    }).eq("id", thread["id"]).execute()


async def _execute_wa_tools(tool_calls: list, tenant, contact: dict, language: str) -> str:
    """Execute LLM tool calls and return a combined response string."""
    from api.agent import _resolve_datetime  # NLP date parser (handles natural language + Malay)
    results = []

    for tc in tool_calls:
        fn_name = tc["function"]["name"]
        args = tc["function"]["arguments"]

        if fn_name == "book_appointment":
            scheduled_dt = _resolve_datetime(args.get("date", ""), args.get("time", ""))
            if not scheduled_dt:
                results.append("I couldn't understand the date and time. Please confirm the date and time with the patient.")
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
                svc = args.get('service_type', '')
                date_ = args.get('date', '')
                time_ = args.get('time', '')
                if language == "ms":
                    results.append(f"Berjaya! Temujanji {svc} anda telah ditetapkan pada {date_} jam {time_}.")
                elif language == "zh":
                    results.append(f"成功！您的{svc}预约已定于{date_} {time_}。")
                else:
                    results.append(f"Done! Your {svc} appointment is booked for {date_} at {time_}.")
            else:
                msg = result.get("message", "")
                if language == "ms":
                    results.append(msg or "Maaf, penempahan tidak berjaya. Sila cuba lagi.")
                elif language == "zh":
                    results.append(msg or "抱歉，预约未能完成，请再试一次。")
                else:
                    results.append(msg or "Sorry, I couldn't complete that booking.")

        elif fn_name == "check_slots":
            try:
                date_obj = datetime.strptime(args["date"], "%Y-%m-%d")
            except (ValueError, KeyError):
                if language == "ms":
                    results.append("Sila berikan tarikh yang tepat.")
                else:
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
                if language == "ms":
                    results.append(f"Masa yang tersedia pada {args['date']}: {slots}\nPilih masa yang sesuai untuk anda.")
                elif language == "zh":
                    results.append(f"{args['date']} 的可用时间：{slots}\n请选择您方便的时间。")
                else:
                    results.append(f"Available times on {args['date']}: {slots}\nWhich time works for you?")
            else:
                if language == "ms":
                    results.append(f"Tiada masa yang tersedia pada {args['date']}. Cuba tarikh lain?")
                elif language == "zh":
                    results.append(f"{args['date']} 没有可用时间，请尝试其他日期。")
                else:
                    results.append(f"No available slots on {args['date']}. Try another date?")

        elif fn_name == "cancel_appointment":
            result = await cancel_appointment(
                tenant_id=tenant.tenant_id,
                booking_id=args.get("booking_id"),
                contact_phone=args.get("contact_phone") or contact.get("phone"),
            )
            if result["success"]:
                from datetime import datetime as dt
                t = dt.fromisoformat(result["scheduled_at"]).strftime("%d %b, %I:%M %p")
                if language == "ms":
                    results.append(f"Temujanji anda pada {t} telah dibatalkan.")
                elif language == "zh":
                    results.append(f"您在{t}的预约已取消。")
                else:
                    results.append(f"Your appointment on {t} has been cancelled.")
            else:
                msg = result.get("message", "")
                if language == "ms":
                    results.append(msg or "Saya tidak dapat mencari temujanji tersebut.")
                else:
                    results.append(msg or "I couldn't find that appointment.")

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
                new = dt.fromisoformat(result["new_time"]).strftime("%d %b, %I:%M %p")
                if language == "ms":
                    results.append(f"Berjaya ditukar! Temujanji baru anda pada {new}.")
                elif language == "zh":
                    results.append(f"改期成功！您的新预约时间是{new}。")
                else:
                    results.append(f"Rescheduled! Your new appointment is on {new}.")
            else:
                err = result.get("error", "")
                if language == "ms":
                    results.append(err or "Tidak dapat menukar temujanji. Sila hubungi kami.")
                else:
                    results.append(err or "Couldn't reschedule that appointment.")

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
    """Send a WhatsApp text message via Meta Cloud API v21."""
    # Normalise: Meta send API expects digits only (no +)
    to_digits = to.lstrip("+")
    url = f"https://graph.facebook.com/v21.0/{phone_number_id}/messages"
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(
            url,
            json={
                "messaging_product": "whatsapp",
                "to": to_digits,
                "type": "text",
                "text": {"body": text},
            },
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
        )
        if not response.is_success:
            error_body = response.text
            logger.error(
                f"Meta send failed {response.status_code} | phone_id={phone_number_id} | "
                f"to={to_digits} | body={error_body}"
            )
            # Raise with full Meta error body so callers (test-send, etc.) can surface it
            raise RuntimeError(f"Meta API error {response.status_code}: {error_body}")
        return response.json()


# ── Validate credentials endpoint ─────────────────────────────────────────────

@router.post("/whatsapp/validate-credentials/{tenant_id}")
async def validate_whatsapp_credentials(tenant_id: str, request: Request):
    """Called when user saves credentials — checks phone_number_id is valid before we accept it."""
    try:
        body = await request.json()
    except Exception:
        return {"valid": False, "error": "Invalid request body"}

    phone_number_id = str(body.get("phone_number_id", "")).strip()
    access_token = str(body.get("access_token", "")).strip()

    if not phone_number_id or not access_token:
        return {"valid": False, "error": "phone_number_id and access_token are required"}

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f"https://graph.facebook.com/v21.0/{phone_number_id}",
                params={"fields": "id,display_phone_number,verified_name", "access_token": access_token},
            )
        data = r.json()
    except Exception as e:
        return {"valid": False, "error": f"Could not reach Meta API: {e}"}

    if r.is_success and "display_phone_number" in data:
        return {
            "valid": True,
            "display_phone_number": data.get("display_phone_number"),
            "verified_name": data.get("verified_name"),
        }

    err_msg = data.get("error", {}).get("message", r.text) if isinstance(data, dict) else r.text
    hint = ""
    if "does not exist" in err_msg or "missing permissions" in err_msg:
        hint = (
            " You may have entered the WhatsApp Business Account ID instead of the Phone Number ID. "
            "In Meta Developer Portal → your App → WhatsApp → API Setup, the Phone Number ID is "
            "the number shown directly below your registered phone number."
        )
    return {"valid": False, "error": f"{err_msg}.{hint}"}


# ── Test-send endpoint ─────────────────────────────────────────────────────────

@router.post("/whatsapp/test-send/{tenant_id}")
async def test_whatsapp_send(tenant_id: str, request: Request):
    """Dashboard button: verify that WhatsApp send credentials are working."""
    try:
        body = await request.json()
    except Exception:
        return {"success": False, "error": "Invalid request body"}

    to_phone = body.get("to_phone", "").strip()
    if not to_phone:
        return {"success": False, "error": "to_phone is required"}

    tenant = await get_tenant_by_id(tenant_id)
    if not tenant:
        return {"success": False, "error": "Tenant not found"}
    if not tenant.wa_phone_number_id or not tenant.wa_access_token:
        return {
            "success": False,
            "error": "WhatsApp credentials not saved. Fill in Phone Number ID and Access Token then click Save & Connect.",
        }

    # Step 1: validate that the phone_number_id is actually a Phone Number ID,
    # not the WhatsApp Business Account ID (a very common mix-up).
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            check = await client.get(
                f"https://graph.facebook.com/v21.0/{tenant.wa_phone_number_id}",
                params={"fields": "id,display_phone_number", "access_token": tenant.wa_access_token},
            )
        check_data = check.json()
        if not check.is_success or "display_phone_number" not in check_data:
            err_msg = check_data.get("error", {}).get("message", check.text)
            hint = (
                " It looks like you may have entered the WhatsApp Business Account ID in the "
                "Phone Number ID field — these are two different numbers. "
                "Go to Meta Developer Portal → your App → WhatsApp → API Setup and copy the "
                "'Phone Number ID' shown directly next to your phone number."
            )
            return {"success": False, "error": f"Invalid Phone Number ID: {err_msg}.{hint}"}
    except Exception as e:
        return {"success": False, "error": f"Could not validate Phone Number ID: {e}"}

    # Step 2: send the test message
    try:
        result = await send_whatsapp_message(
            to=to_phone,
            text="✅ Test message from AI Receptionist — your WhatsApp connection is working!",
            phone_number_id=tenant.wa_phone_number_id,
            access_token=tenant.wa_access_token,
        )
        return {"success": True, "result": result}
    except Exception as e:
        return {"success": False, "error": str(e)}
