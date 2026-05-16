"""
WhatsApp Webhook Handlers (Meta Cloud API)
Handles incoming messages from clinic WhatsApp Business numbers.
Integrates guardrails: emergency detection, escalation phrases, human-takeover mode.

Performance notes:
- Webhook returns 200 immediately; message processing runs as a background task.
- All Supabase calls use _db() to avoid blocking the async event loop.
- Tenant config is cached for 60 s in tenant_config.py.
"""

import sys
import os
import re
import json
import hmac
import hashlib
from datetime import datetime, timedelta

import httpx
from fastapi import APIRouter, Request, HTTPException, Response, BackgroundTasks

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.tenant_config import get_tenant_by_wa_phone_id, get_tenant_by_id, get_supabase_client, _db
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
    return f"wa_{tenant_id.replace('-', '')[:16]}"


@router.get("/whatsapp/{tenant_id}")
async def whatsapp_verify(tenant_id: str, request: Request):
    mode = request.query_params.get("hub.mode")
    token = request.query_params.get("hub.verify_token")
    challenge = request.query_params.get("hub.challenge")
    if mode == "subscribe" and token == _derive_verify_token(tenant_id):
        return Response(content=challenge, media_type="text/plain")
    raise HTTPException(status_code=403, detail="Verification failed")


# ── Incoming message webhook ───────────────────────────────────────────────────

@router.post("/whatsapp/{tenant_id}")
async def whatsapp_webhook(tenant_id: str, request: Request, background_tasks: BackgroundTasks):
    """
    Returns 200 immediately after dedup + tenant checks.
    Heavy processing (LLM call, DB writes, WA send) runs in background_tasks
    so Meta never times out waiting for us.
    """
    raw_body = await request.body()

    # Verify Meta webhook signature (set WA_APP_SECRET in Railway env vars)
    app_secret = os.getenv("WA_APP_SECRET", "")
    if app_secret:
        sig_header = request.headers.get("X-Hub-Signature-256", "")
        expected   = "sha256=" + hmac.new(
            app_secret.encode(), raw_body, hashlib.sha256
        ).hexdigest()
        if not sig_header or not hmac.compare_digest(sig_header, expected):
            logger.warning(f"Rejected webhook with invalid HMAC for tenant {tenant_id}")
            return {"status": "invalid_signature"}

    try:
        payload = json.loads(raw_body)
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

        # Dedup check — synchronous before returning 200 so we don't spawn
        # duplicate background tasks for the same WA message.
        supabase = get_supabase_client()
        if wa_message_id:
            already = await _db(lambda: supabase.table("messages").select("id").eq(
                "wa_message_id", wa_message_id
            ).limit(1).execute())
            if already.data:
                logger.info(f"Duplicate WA message skipped: {wa_message_id}")
                return {"status": "duplicate"}

        tenant = await get_tenant_by_id(tenant_id)
        if not tenant or not tenant.is_active:
            logger.warning(f"Unknown or inactive tenant: {tenant_id}")
            return {"status": "unknown_tenant"}

        if not tenant.wa_phone_number_id or not tenant.wa_access_token:
            logger.warning(f"Tenant {tenant_id} missing WA credentials — cannot reply")
            return {"status": "no_credentials"}

        # Return 200 now; process in background
        background_tasks.add_task(handle_whatsapp_message, tenant, message, value)
        return {"status": "ok"}

    except Exception as e:
        logger.error(f"WhatsApp webhook error: {e}", exc_info=True)
        return {"status": "error", "detail": str(e)}


# ── Message handler ────────────────────────────────────────────────────────────

async def _download_wa_media(media_id: str, access_token: str) -> bytes:
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

    from openai import AsyncOpenAI
    api_key = _cred(tenant, "openai", "api_key")
    if not api_key:
        raise ValueError("No OpenAI API key for transcription")
    client = AsyncOpenAI(api_key=api_key)
    audio_file = io.BytesIO(audio_bytes)
    audio_file.name = "audio.ogg"
    transcript = await client.audio.transcriptions.create(model="whisper-1", file=audio_file)
    return transcript.text


async def _generate_tts_ogg(text: str, voice: str, tenant) -> bytes:
    from openai import AsyncOpenAI
    from shared.providers import _cred
    api_key = _cred(tenant, "openai", "api_key")
    if not api_key:
        raise ValueError("No OpenAI API key for TTS")
    client = AsyncOpenAI(api_key=api_key)
    response = await client.audio.speech.create(
        model="tts-1", voice=voice or "nova", input=text, response_format="opus",
    )
    return response.content


async def _upload_wa_media(audio_bytes: bytes, phone_number_id: str, access_token: str) -> str:
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
    url = f"https://graph.facebook.com/v21.0/{phone_number_id}/messages"
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            url,
            json={"messaging_product": "whatsapp", "to": to, "type": "audio", "audio": {"id": media_id}},
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        )
        r.raise_for_status()


def _parse_embedded_tool_calls(text: str):
    """Extract <function=NAME>JSON</function> tags embedded by some models (Llama/Groq)."""
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
        r"<function=([^>]+)>(.*?)</function>", _replacer, text, flags=re.DOTALL
    ).strip()
    return cleaned, tool_calls


def _build_date_context(
    reply_language: str = "ask",
    is_new_conversation: bool = False,
    conversation_language: str = "en",
) -> str:
    now = datetime.now()
    tomorrow = now + timedelta(days=1)

    if reply_language == "en":
        lang_rule = "⚠️ CRITICAL — ENGLISH: Reply in ENGLISH ONLY. Every word must be English. No Malay, no Chinese. No exceptions."
    elif reply_language == "ms":
        lang_rule = "⚠️ KRITIKAL — BAHASA MELAYU: Balas dalam BAHASA MELAYU SAHAJA. Setiap patah perkataan mesti Bahasa Melayu. Tiada perkataan Inggeris. Tiada pengecualian."
    elif reply_language == "zh":
        lang_rule = "⚠️ 严重警告 — 中文：只能用中文回复。每一个字都必须是中文，不允许任何英文或马来文。没有例外。"
    else:
        if is_new_conversation:
            lang_rule = (
                "⚠️ LANGUAGE FIRST: This is the very first message. Before anything else, ask: "
                "'Hello! Would you prefer to chat in English, Bahasa Melayu, or Chinese?' "
                "Do NOT answer any other question until the user confirms their language."
            )
        elif conversation_language == "ms":
            lang_rule = (
                "⚠️ KRITIKAL — BAHASA MELAYU: Pengguna telah memilih Bahasa Melayu. "
                "SETIAP patah perkataan dalam balasan anda MESTI dalam Bahasa Melayu. "
                "Tiada perkataan Inggeris langsung. Ini peraturan WAJIB. Tiada pengecualian."
            )
        elif conversation_language == "zh":
            lang_rule = (
                "⚠️ 严重警告 — 中文：用户已选择中文。"
                "您回复中的每一个字都必须是中文。"
                "绝对不允许出现任何英文或其他语言文字。这是强制规定，没有例外。"
            )
        else:
            lang_rule = (
                "⚠️ CRITICAL — ENGLISH: The user has chosen English. "
                "EVERY word in your reply MUST be in English. "
                "No Malay, no Chinese, no mixed language. This is MANDATORY. No exceptions."
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

    detected_lang = detect_language(message_text)
    formatted_phone = format_phone_number(from_number)

    contact_result = await get_or_create_contact(
        tenant_id=tenant.tenant_id, phone=formatted_phone, source="whatsapp",
    )
    contact = contact_result.get("contact", {})

    thread_result = await _db(lambda: supabase.table("whatsapp_threads").select("*").eq(
        "tenant_id", tenant.tenant_id
    ).eq("contact_number", formatted_phone).order("created_at", desc=True).limit(1).execute())

    if thread_result.data:
        thread = thread_result.data[0]
        thread_lang = thread.get("language") or "en"
        language = detected_lang if detected_lang in ("ms", "zh") else thread_lang
        if thread.get("status") == "human_takeover":
            await _db(lambda: supabase.table("messages").insert({
                "thread_id": thread["id"],
                "tenant_id": tenant.tenant_id,
                "contact_id": contact.get("id"),
                "wa_message_id": message.get("id"),
                "role": "user",
                "body": message_text,
                "language": language,
                "handled_by": "human",
            }).execute())
            return
    else:
        language = detected_lang
        new_thread = await _db(lambda: supabase.table("whatsapp_threads").insert({
            "tenant_id": tenant.tenant_id,
            "contact_id": contact.get("id"),
            "contact_number": formatted_phone,
            "contact_name": contact.get("name"),
            "language": language,
            "status": "ai",
            "last_message_at": datetime.now().isoformat(),
        }).execute())
        thread = new_thread.data[0]

    # ── Guardrails ──────────────────────────────────────────────────────────────
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

    # ── Feedback campaign intercept ─────────────────────────────────────────────
    # Check before LLM: if there's a pending feedback campaign and the patient
    # replied with a 1-5 rating, handle it here and skip the booking AI entirely.
    if contact.get("id"):
        from api.campaigns import get_pending_feedback_campaign, extract_rating, handle_feedback_response
        _pending = await get_pending_feedback_campaign(tenant.tenant_id, contact["id"])
        if _pending:
            _rating = extract_rating(message_text)
            if _rating is not None:
                await handle_feedback_response(
                    tenant=tenant,
                    contact=contact,
                    thread=thread,
                    from_number=from_number,
                    campaign=_pending,
                    rating=_rating,
                    message_text=message_text,
                    language=language,
                )
                return

    history_result = await _db(lambda: supabase.table("messages").select("role, body").eq(
        "thread_id", thread["id"]
    ).order("created_at", desc=False).limit(20).execute())

    conversation_history = [
        {"role": m["role"], "content": m["body"]} for m in history_result.data
    ]
    conversation_history.append({"role": "user", "content": message_text})

    await _db(lambda: supabase.table("messages").insert({
        "thread_id": thread["id"],
        "tenant_id": tenant.tenant_id,
        "contact_id": contact.get("id"),
        "wa_message_id": message.get("id"),
        "role": "user",
        "body": message_text,
        "language": language,
        "handled_by": "ai",
    }).execute())

    llm_client = load_llm_client(tenant)
    is_new_conversation = len(conversation_history) == 1
    date_context = _build_date_context(
        reply_language=getattr(tenant, "reply_language", "ask"),
        is_new_conversation=is_new_conversation,
        conversation_language=language,
    )

    messages_payload = [
        {"role": "system", "content": tenant.system_prompt + date_context},
        *conversation_history,
    ]

    all_tools = [t for t in TOOL_DEFINITIONS if tenant.tool_config.get(t["function"]["name"], True)]
    enabled_tools = _select_tools(all_tools, history_result.data, message_text)

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
        reply_text = "I'm sorry, I couldn't process that. Please try again or call us directly."

    await _db(lambda: supabase.table("messages").insert({
        "thread_id": thread["id"],
        "tenant_id": tenant.tenant_id,
        "contact_id": contact.get("id"),
        "role": "assistant",
        "body": reply_text,
        "language": language,
        "handled_by": "ai",
    }).execute())

    thread_update: dict = {"last_message_at": datetime.now().isoformat(), "language": language}
    if contact.get("name"):
        thread_update["contact_name"] = contact["name"]
    await _db(lambda: supabase.table("whatsapp_threads").update(thread_update).eq(
        "id", thread["id"]
    ).execute())

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
    language = "en"
    formatted_phone = format_phone_number(from_number)

    contact_result = await get_or_create_contact(
        tenant_id=tenant.tenant_id, phone=formatted_phone, source="whatsapp"
    )
    contact = contact_result.get("contact", {})

    thread_result = await _db(lambda: supabase.table("whatsapp_threads").select("*").eq(
        "tenant_id", tenant.tenant_id
    ).eq("contact_number", formatted_phone).order("created_at", desc=True).limit(1).execute())

    if thread_result.data:
        thread = thread_result.data[0]
        if thread.get("status") == "human_takeover":
            await _db(lambda: supabase.table("messages").insert({
                "thread_id": thread["id"], "tenant_id": tenant.tenant_id,
                "contact_id": contact.get("id"), "wa_message_id": message.get("id"),
                "role": "user", "body": "[Voice message]",
                "language": language, "handled_by": "human",
            }).execute())
            return
    else:
        new_thread = await _db(lambda: supabase.table("whatsapp_threads").insert({
            "tenant_id": tenant.tenant_id, "contact_id": contact.get("id"),
            "contact_number": formatted_phone, "language": language,
            "status": "ai", "last_message_at": datetime.now().isoformat(),
        }).execute())
        thread = new_thread.data[0]

    try:
        audio_bytes = await _download_wa_media(media_id, tenant.wa_access_token)
        stt_provider = getattr(tenant, "voice_stt_provider", None) or "openai"
        transcript = await _transcribe_audio(audio_bytes, stt_provider, tenant)
        if not transcript.strip():
            transcript = "[Could not transcribe voice message]"
    except Exception as e:
        logger.error(f"STT error: {e}")
        await send_whatsapp_message(
            to=from_number,
            text="Sorry, I couldn't understand that voice message. Please try sending a text message.",
            phone_number_id=tenant.wa_phone_number_id,
            access_token=tenant.wa_access_token,
        )
        return

    language = detect_language(transcript)

    history = await _db(lambda: supabase.table("messages").select("role, body").eq(
        "thread_id", thread["id"]
    ).order("created_at", desc=False).limit(20).execute())
    conversation_history = [{"role": m["role"], "content": m["body"]} for m in history.data]
    conversation_history.append({"role": "user", "content": transcript})

    await _db(lambda: supabase.table("messages").insert({
        "thread_id": thread["id"], "tenant_id": tenant.tenant_id,
        "contact_id": contact.get("id"), "wa_message_id": message.get("id"),
        "role": "user", "body": transcript,
        "language": language, "handled_by": "ai",
    }).execute())

    llm_client = load_llm_client(tenant)
    is_new_conversation = len(conversation_history) == 1
    date_context = _build_date_context(
        reply_language=getattr(tenant, "reply_language", "ask"),
        is_new_conversation=is_new_conversation,
        conversation_language=language,
    )
    messages_payload = [
        {"role": "system", "content": tenant.system_prompt + date_context},
        *conversation_history,
    ]
    all_tools = [t for t in TOOL_DEFINITIONS if tenant.tool_config.get(t["function"]["name"], True)]
    enabled_tools = _select_tools(all_tools, history.data, transcript)
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

    await _db(lambda: supabase.table("messages").insert({
        "thread_id": thread["id"], "tenant_id": tenant.tenant_id,
        "contact_id": contact.get("id"), "role": "assistant", "body": reply_text,
        "language": language, "handled_by": "ai",
    }).execute())

    await _db(lambda: supabase.table("whatsapp_threads").update({
        "last_message_at": datetime.now().isoformat(), "language": language,
    }).eq("id", thread["id"]).execute())


# ── Tool selection state machine ───────────────────────────────────────────────

_SLOT_MARKERS = ("available times", "masa yang tersedia", "可用时间", "available slot", "pilih masa")
_CANCEL_KEYWORDS = ("cancel", "batal", "batalkan", "tak jadi", "cancel", "取消")
_RESCHEDULE_KEYWORDS = ("reschedule", "tukar masa", "ubah masa", "move", "change appointment", "改期", "tangguh")
_ALWAYS_ON = {"get_faq", "escalate_to_human"}


def _select_tools(all_tools: list, history_messages: list, current_text: str) -> list:
    all_text = " ".join(m["body"].lower() for m in history_messages) + " " + current_text.lower()
    assistant_text = " ".join(m["body"].lower() for m in history_messages if m["role"] == "assistant")

    slots_shown = any(marker in assistant_text for marker in _SLOT_MARKERS)
    wants_cancel = any(kw in all_text for kw in _CANCEL_KEYWORDS)
    wants_reschedule = any(kw in all_text for kw in _RESCHEDULE_KEYWORDS)

    allowed: set[str] = set(_ALWAYS_ON)

    if slots_shown:
        allowed.add("book_appointment")
    else:
        allowed.add("check_slots")

    if wants_cancel:
        allowed.add("cancel_appointment")

    if wants_reschedule:
        allowed.add("reschedule_appointment")
        allowed.discard("check_slots")
        allowed.discard("book_appointment")

    return [t for t in all_tools if t["function"]["name"] in allowed]


# ── Booking validation ─────────────────────────────────────────────────────────

_BOOKING_PLACEHOLDERS = {
    "name", "your name", "patient name", "patient", "unknown", "n/a", "tba",
    "[name]", "[patient name]", "[service]", "[service type]", "[phone]",
    "nama", "nama anda", "nama pesakit", "pesakit", "perkhidmatan",
    "perkhidmatan yang diperlukan", "jenis perkhidmatan", "nombor telefon",
    "姓名", "服务", "电话",
}


def _is_placeholder(value: str) -> bool:
    if not value or not value.strip():
        return True
    return value.strip().lower() in _BOOKING_PLACEHOLDERS or value.strip().startswith("[")


def _is_valid_phone(phone: str) -> bool:
    return len(re.sub(r"\D", "", phone)) >= 8


# ── Tool executor ──────────────────────────────────────────────────────────────

async def _execute_wa_tools(tool_calls: list, tenant, contact: dict, language: str) -> str:
    from api.agent import _resolve_datetime
    results = []

    for tc in tool_calls:
        fn_name = tc["function"]["name"]
        args = tc["function"]["arguments"]

        if fn_name == "book_appointment":
            contact_name = args.get("contact_name", "").strip() or contact.get("name", "")
            contact_phone = args.get("contact_phone", "").strip() or contact.get("phone", "")
            service_type = args.get("service_type", "").strip()

            missing = []
            if _is_placeholder(contact_name):
                missing.append("name" if language == "en" else "nama" if language == "ms" else "姓名")
            if not _is_valid_phone(contact_phone):
                missing.append("phone number" if language == "en" else "nombor telefon" if language == "ms" else "电话")
            if _is_placeholder(service_type):
                missing.append("service type" if language == "en" else "jenis perkhidmatan" if language == "ms" else "服务类型")

            if missing:
                missing_str = ", ".join(missing)
                if language == "ms":
                    results.append(f"Saya masih perlukan: {missing_str}.")
                elif language == "zh":
                    results.append(f"还需要以下信息：{missing_str}。")
                else:
                    results.append(f"I still need: {missing_str}.")
                continue

            scheduled_dt = _resolve_datetime(args.get("date", ""), args.get("time", ""))
            if not scheduled_dt:
                if language == "ms":
                    results.append("Saya tidak faham tarikh/masa. Boleh nyatakan semula?")
                else:
                    results.append("I couldn't understand the date and time. Please clarify.")
                continue

            result = await book_appointment(
                tenant_id=tenant.tenant_id,
                contact_id=contact.get("id"),
                contact_name=contact_name,
                contact_phone=contact_phone,
                service_type=service_type,
                scheduled_at=scheduled_dt,
                tenant_config=tenant,
                notes=args.get("notes"),
                source="whatsapp",
            )
            if result["success"]:
                # Update contact record so appointments dashboard shows real name
                existing_name = (contact.get("name") or "").strip().lower()
                if contact_name and existing_name in ("", "unknown"):
                    try:
                        supabase = get_supabase_client()
                        _cid = contact.get("id")
                        await _db(lambda: supabase.table("contacts").update(
                            {"name": contact_name}
                        ).eq("id", _cid).execute())
                        contact["name"] = contact_name
                    except Exception as _e:
                        logger.warning(f"Failed to update contact name: {_e}")

                svc = args.get("service_type", "")
                date_ = args.get("date", "")
                time_ = args.get("time", "")
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


async def _handle_wa_escalation(tenant, thread: dict, contact: dict, from_number: str, reason: str, reply: str, supabase):
    _tid = thread["id"]
    await _db(lambda: supabase.table("whatsapp_threads").update(
        {"status": "human_takeover"}
    ).eq("id", _tid).execute())

    await escalate_to_human(
        tenant_id=tenant.tenant_id,
        reason=reason,
        context=f"WhatsApp escalation — thread {thread['id']}",
        source="whatsapp",
    )

    await send_whatsapp_message(
        to=from_number, text=reply,
        phone_number_id=tenant.wa_phone_number_id,
        access_token=tenant.wa_access_token,
    )


# ── Meta send helper ───────────────────────────────────────────────────────────

async def send_whatsapp_message(to: str, text: str, phone_number_id: str, access_token: str):
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
            raise RuntimeError(f"Meta API error {response.status_code}: {error_body}")
        return response.json()


# ── Validate credentials endpoint ─────────────────────────────────────────────

@router.post("/whatsapp/validate-credentials/{tenant_id}")
async def validate_whatsapp_credentials(tenant_id: str, request: Request):
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
