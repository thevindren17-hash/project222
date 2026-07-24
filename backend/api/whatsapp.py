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
import time
import asyncio
from collections import defaultdict, deque
from datetime import datetime, timedelta
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, Request, HTTPException, Response, BackgroundTasks

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.tenant_config import get_tenant_by_wa_phone_id, get_tenant_by_id, get_supabase_client, _db
from shared.providers import load_llm_client
from shared.security import require_internal_secret
from shared.tools import (
    book_appointment,
    check_slots,
    cancel_appointment,
    reschedule_appointment,
    get_faq,
    escalate_to_human,
    get_or_create_contact,
    lookup_patient,
    TOOL_DEFINITIONS,
    BASE_FIELD_HINTS,
    RESERVED_TOOL_NAMES,
    run_custom_tool,
)
from shared.utils import (
    detect_language,
    parse_datetime,
    format_phone_number,
    check_emergency,
    check_escalation_request,
    conversation_mentions_a_date,
    logger,
)

router = APIRouter()

# ── Per-contact rate limiter ──────────────────────────────────────────────────
# Keeps an in-memory deque of message timestamps per (tenant, phone) pair.
# Limits to 5 messages per contact per 60 seconds to prevent spam/credit burn.
_rate_limit_store: dict = defaultdict(lambda: deque(maxlen=10))
_RATE_WINDOW   = 60   # seconds
_RATE_MAX_MSGS = 5    # max messages per window

def _is_rate_limited(key: str) -> bool:
    now = time.monotonic()
    q = _rate_limit_store[key]
    while q and now - q[0] > _RATE_WINDOW:
        q.popleft()
    if len(q) >= _RATE_MAX_MSGS:
        return True
    q.append(now)
    return False

# ── Per-tenant aggregate rate limiter ─────────────────────────────────────────
# The per-contact limiter above doesn't cap total volume across MANY distinct
# senders — an attacker controlling several real WhatsApp numbers could still
# drive unbounded LLM spend against one clinic's BYOK key. This is a coarse
# ceiling, generous enough that no real clinic should ever hit it in normal
# use, but bounds the worst case.
_tenant_rate_limit_store: dict = defaultdict(lambda: deque(maxlen=200))
_TENANT_RATE_WINDOW   = 60   # seconds
_TENANT_RATE_MAX_MSGS = 100  # max messages per tenant per window

def _is_tenant_rate_limited(tenant_id: str) -> bool:
    now = time.monotonic()
    q = _tenant_rate_limit_store[tenant_id]
    while q and now - q[0] > _TENANT_RATE_WINDOW:
        q.popleft()
    if len(q) >= _TENANT_RATE_MAX_MSGS:
        return True
    q.append(now)
    return False

# ── Maximum inbound message length before LLM ────────────────────────────────
_MAX_MSG_CHARS = 4000


# ── Contact audit log helper ──────────────────────────────────────────────────
async def _log_contact_change(
    tenant_id: str, contact_id: str,
    field: str, old_value: str, new_value: str,
    changed_by: str = "system",
) -> None:
    try:
        supabase = get_supabase_client()
        await _db(lambda: supabase.table("contact_audit_log").insert({
            "tenant_id": tenant_id,
            "contact_id": contact_id,
            "changed_by": changed_by,
            "field": field,
            "old_value": old_value,
            "new_value": new_value,
        }).execute())
    except Exception as _e:
        logger.warning(f"Audit log write failed: {_e}")


# ── Opt-out / unsubscribe ─────────────────────────────────────────────────────

_OPT_OUT_RE = re.compile(
    r'\b(stop|unsubscribe|opt[\s-]?out|berhenti|退订|停止)\b',
    re.IGNORECASE,
)
_OPT_OUT_REPLIES = {
    "en": "You've been unsubscribed from our messages. You won't receive further automated notifications. Reply START to re-subscribe.",
    "ms": "Anda telah berhenti langgan mesej kami. Anda tidak akan menerima pemberitahuan lanjut. Balas MULA untuk langgan semula.",
    "zh": "您已取消订阅我们的消息。您将不再收到自动通知。回复“开始”以重新订阅。",
}


# ── Webhook verification ───────────────────────────────────────────────────────

def _derive_verify_token(tenant_id: str) -> str:
    return f"wa_{tenant_id.replace('-', '')[:16]}"


@router.get("/whatsapp/{tenant_id}")
async def whatsapp_verify(tenant_id: str, request: Request):
    mode = request.query_params.get("hub.mode")
    token = request.query_params.get("hub.verify_token")
    challenge = request.query_params.get("hub.challenge")
    if mode == "subscribe":
        tenant = await get_tenant_by_id(tenant_id)
        # Use stored random verify token if set, fall back to derived for legacy setups
        expected = (
            tenant.wa_verify_token
            if tenant and tenant.wa_verify_token
            else _derive_verify_token(tenant_id)
        )
        if token == expected:
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

    # Verify Meta webhook signature (set WA_APP_SECRET in Railway env vars).
    # Fails CLOSED: a missing secret rejects the request rather than skipping
    # verification, so a misconfigured deployment can't silently accept forged payloads.
    app_secret = os.getenv("WA_APP_SECRET", "")
    if not app_secret:
        logger.error(f"WA_APP_SECRET is not configured — rejecting webhook for tenant {tenant_id}")
        return {"status": "misconfigured"}

    sig_header = request.headers.get("X-Hub-Signature-256", "")
    expected = "sha256=" + hmac.new(
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

        # Atomic dedup — INSERT into webhook_dedup (unique PRIMARY KEY).
        # A conflict = the same message_id is already being processed.
        # Degrades gracefully to a SELECT check if the table isn't created yet.
        supabase = get_supabase_client()
        if wa_message_id:
            try:
                insert_result = await _db(lambda: supabase.table("webhook_dedup").insert(
                    {"wa_message_id": wa_message_id}
                ).execute())
                if not insert_result.data:
                    logger.info(f"Duplicate WA message skipped: {wa_message_id}")
                    return {"status": "duplicate"}
            except Exception as _dedup_exc:
                _s = str(_dedup_exc).lower()
                if "23505" in _s or "unique" in _s or "duplicate" in _s:
                    logger.info(f"Duplicate WA message skipped: {wa_message_id}")
                    return {"status": "duplicate"}
                # Table not yet created — fall back to legacy SELECT check
                if "42p01" not in _s:
                    logger.warning(f"webhook_dedup unexpected error: {_dedup_exc}")
                _already = await _db(lambda: supabase.table("messages").select("id").eq(
                    "wa_message_id", wa_message_id
                ).limit(1).execute())
                if _already.data:
                    logger.info(f"Duplicate WA message skipped (legacy): {wa_message_id}")
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

    if provider == "groq":
        from openai import AsyncOpenAI
        api_key = _cred(tenant, "groq", "api_key")
        if not api_key:
            raise ValueError("No Groq API key for transcription")
        client = AsyncOpenAI(api_key=api_key, base_url="https://api.groq.com/openai/v1")
        audio_file = io.BytesIO(audio_bytes)
        audio_file.name = "audio.ogg"
        transcript = await client.audio.transcriptions.create(model="whisper-large-v3-turbo", file=audio_file)
        return transcript.text

    from openai import AsyncOpenAI
    api_key = _cred(tenant, "openai", "api_key")
    if not api_key:
        raise ValueError("No OpenAI API key for transcription")
    client = AsyncOpenAI(api_key=api_key)
    audio_file = io.BytesIO(audio_bytes)
    audio_file.name = "audio.ogg"
    transcript = await client.audio.transcriptions.create(model="whisper-1", file=audio_file)
    return transcript.text


# Built-in per-language voice defaults, used when a tenant hasn't picked one.
# ElevenLabs IDs are real, verified voices (from a proven multilingual voice
# agent build) — English/Bahasa Melayu/Mandarin, picked from the ElevenLabs
# Voice Library and confirmed working for this language set.
DEFAULT_TTS_VOICE_MAP = {
    "openai": {"en": "nova", "ms": "nova", "zh": "shimmer"},
    "elevenlabs": {
        "en": "cgSgspJ2msm6clMCkdW9",
        "ms": "qAJVXEQ6QgjOQ25KuoU8",
        "zh": "tOuLUAIdXShmWH7PEUrU",
    },
}


async def _generate_tts_ogg(text: str, provider: str, voice_id: str, tenant) -> bytes:
    from shared.providers import _cred

    if provider == "elevenlabs":
        api_key = _cred(tenant, "elevenlabs", "api_key")
        if not api_key:
            raise ValueError("No ElevenLabs API key for TTS")
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
                params={"output_format": "opus_48000_128"},
                headers={"xi-api-key": api_key, "Content-Type": "application/json"},
                json={"text": text, "model_id": "eleven_flash_v2_5"},
            )
            r.raise_for_status()
            return r.content

    from openai import AsyncOpenAI
    api_key = _cred(tenant, "openai", "api_key")
    if not api_key:
        raise ValueError("No OpenAI API key for TTS")
    client = AsyncOpenAI(api_key=api_key)
    response = await client.audio.speech.create(
        model="tts-1", voice=voice_id or "nova", input=text, response_format="opus",
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
    timezone: str = "Asia/Kuala_Lumpur",
    custom_booking_fields: Optional[list] = None,
    base_field_labels: Optional[dict] = None,
    custom_tools: Optional[list] = None,
) -> str:
    try:
        from zoneinfo import ZoneInfo
        now = datetime.now(tz=ZoneInfo(timezone))
    except Exception as e:
        # This "now"/"tomorrow" pair is what the AI resolves "today"/"tomorrow"
        # against -- falling back to naive UTC silently shifts the resolved
        # calendar date by a day during part of the clinic's local day (the
        # historical cause was a missing tzdata install). Log loudly.
        logger.error(f"ZoneInfo({timezone!r}) failed, falling back to naive server time: {e}")
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

    # Each custom field belongs to exactly one action/tool (book_appointment,
    # cancel_appointment, or reschedule_appointment) — matching how the AI
    # actually calls one tool at a time. Group by action so each gets the
    # right prompt guidance and tool-call argument names.
    all_custom_fields = custom_booking_fields or []
    booking_fields = [f for f in all_custom_fields if f.get("action", "book_appointment") == "book_appointment" and f.get("key")]
    cancel_fields = [f for f in all_custom_fields if f.get("action") == "cancel_appointment" and f.get("key")]
    reschedule_fields = [f for f in all_custom_fields if f.get("action") == "reschedule_appointment" and f.get("key")]

    def _field_lines(fields):
        return "\n".join(
            f"    - {f.get('label') or f.get('key')}: {f.get('instruction') or ''}".rstrip(": ")
            for f in fields
        )

    custom_fields_step = ""
    custom_fields_rule = ""
    if booking_fields:
        custom_fields_step = (
            f"  Step 8b: This clinic also wants to know (ask briefly, one at a time, optional — accept 'skip' or 'no'):\n"
            f"{_field_lines(booking_fields)}\n"
        )
        custom_fields_rule = (
            "- When calling book_appointment, pass any of these clinic-specific fields the patient answered "
            f"using these exact argument names: {', '.join(f['key'] for f in booking_fields)}. "
            "Omit any the patient skipped — never invent a value.\n"
        )

    # A clinic may relabel these for its own vocabulary (e.g. "Case Type"
    # instead of "Service") — the wording changes, but every step below still
    # tells the model the exact tool argument key to pass it as, since a
    # weaker model will otherwise happily invent its own key names (e.g.
    # "name"/"phone_number"/"services") drawn straight from this prose
    # instead of the tool schema, which some providers reject outright.
    labels = base_field_labels or {}
    service_label = labels.get("service_type") or "SERVICE"
    date_label = labels.get("date") or "DATE"
    time_label = labels.get("time") or "TIME"
    name_label = labels.get("contact_name") or "NAME"
    phone_label = labels.get("contact_phone") or "PHONE NUMBER"

    # Same anti-hallucination reinforcement as book_appointment above — a
    # weaker model will otherwise invent its own key names here too (e.g.
    # "date"/"time" instead of "new_date"/"new_time") since those words are
    # what a clinic's own cancel/reschedule flow will naturally use in prose.
    cancel_reschedule_rule = (
        "- CANCEL: cancel_appointment's only real arguments are booking_id (optional — omit it to target the "
        "current patient's own most recent pending booking; never invent one) plus any clinic-specific fields "
        "listed below.\n"
        "- RESCHEDULE: reschedule_appointment's EXACT, LITERAL argument names are new_date (YYYY-MM-DD) and "
        f"new_time (HH:MM), plus optional booking_id — this is the tool argument pair for the new {date_label}/{time_label} "
        "the patient wants, no matter what words the clinic's flow or the patient used for it. NEVER invent "
        "different key names for these (e.g. NOT 'date', 'time', 'new_datetime').\n"
        "- Confirm both the existing appointment and the new date/time with the patient before calling "
        "reschedule_appointment.\n"
        "- NEVER cancel or reschedule an appointment within 2 hours of its start — tell the patient to call the "
        "clinic directly instead (enforced by the system regardless of what you attempt).\n"
    )
    if cancel_fields:
        cancel_reschedule_rule += (
            f"- When cancelling an appointment, also briefly ask (optional):\n{_field_lines(cancel_fields)}\n"
            f"  Pass answered ones to cancel_appointment using these exact argument names: "
            f"{', '.join(f['key'] for f in cancel_fields)}. Omit any skipped.\n"
        )
    if reschedule_fields:
        cancel_reschedule_rule += (
            f"- When rescheduling an appointment, also briefly ask (optional):\n{_field_lines(reschedule_fields)}\n"
            f"  Pass answered ones to reschedule_appointment using these exact argument names: "
            f"{', '.join(f['key'] for f in reschedule_fields)}. Omit any skipped.\n"
        )

    # Clinic-defined custom tools — unlike book/cancel/reschedule these have
    # no fixed conversational moment, so the model needs to be told when to
    # reach for each one and exactly which argument keys to use.
    custom_tools_block = ""
    for ct in (custom_tools or []):
        if not ct.get("enabled", True) or not ct.get("tool_key"):
            continue
        ct_fields = [f for f in ct.get("fields", []) if f.get("key")]
        custom_tools_block += (
            f"- {ct.get('name') or ct['tool_key']}: {ct.get('trigger_instruction') or 'Use when relevant to the conversation.'} "
            f"Call {ct['tool_key']} once you have what you need"
            + (f", asking for each of these (optional — accept 'skip'): {_field_lines(ct_fields)}\n"
               f"  Use these exact argument names: {', '.join(f['key'] for f in ct_fields)}. Omit any skipped.\n"
               if ct_fields else ".\n")
        )
    if custom_tools_block:
        custom_tools_block = "CLINIC-DEFINED CUSTOM TOOLS:\n" + custom_tools_block

    return (
        f"\n\n[SYSTEM INFO — Today is {now.strftime('%A, %d %B %Y')} ({now.strftime('%Y-%m-%d')}). "
        f"Tomorrow is {tomorrow.strftime('%A, %Y-%m-%d')}.\n"
        f"{lang_rule}\n"
        "AVAILABLE TOOL: lookup_patient(contact_phone, contact_name?) — read-only, checks if someone is "
        "already a patient on file by phone number. Use it whenever the clinic's own instructions above "
        "ask you to tell new patients from returning ones, or whenever it's otherwise useful to check.\n"
        "DEFAULT BOOKING FLOW — use this ONLY if the clinic's instructions above don't already describe "
        "their own conversation flow or question order. If they did, follow THEIRS instead — this is "
        "just a fallback, not an override:\n"
        f"  Step 1: Ask what {service_label} they need (e.g. scaling, checkup, whitening) — this is the tool argument service_type.\n"
        f"  Step 2: Ask what {date_label} they prefer — this is the tool argument date.\n"
        "  Step 3: ONLY after you have BOTH service AND date → call check_slots.\n"
        "  Step 4: Present the available times clearly. Ask which time they prefer.\n"
        "  Step 5: If user replies with a number like '10' or '10am', treat it as the time (e.g. 10:00) — this is the tool argument time. Do NOT call check_slots again.\n"
        f"  Step 6: Ask for their {name_label} (if not already given in this conversation) — this is the tool argument contact_name. Once given, briefly acknowledge it (e.g. \"Thanks, {{name}}!\") before your next question — natural, not repeated every message after.\n"
        f"  Step 7: Ask for their {phone_label} (if not already given) — this is the tool argument contact_phone.\n"
        "  Step 8: Ask if they have any NOTES or special requests for this visit (optional — one short question, accept 'no' as an answer) — this is the tool argument notes.\n"
        f"{custom_fields_step}"
        "  Step 9: Confirm all details back to the patient in plain language, then call book_appointment.\n"
        "HARD RULES (these always apply, regardless of which flow — clinic's own or the default above — you're following):\n"
        "- NEVER call check_slots unless you already know the specific date the user wants.\n"
        "- NEVER call book_appointment unless you have all 5 REQUIRED TOOL ARGUMENTS: contact_name, contact_phone, service_type, date, time. "
        "These are the EXACT, LITERAL JSON argument names the tool expects — always use them exactly as written, no matter what words this "
        "prompt or the patient used to talk about them. NEVER invent different key names (e.g. NOT 'name', 'phone_number', 'services', "
        "or a merged date+time field) — doing so makes the tool call fail.\n"
        "- NEVER re-ask for info already given earlier in this conversation.\n"
        "- The contact_name must be text the PATIENT actually typed in this conversation. NEVER invent, guess, assume, or reuse a name from anywhere else — if you don't have a name the patient typed themselves, you MUST ask for it before calling book_appointment.\n"
        "- When user picks a time from the shown list, proceed to collect the remaining required fields — do not show slots again.\n"
        "- Date/time: 'esok'/'tomorrow' → exact date above, '3pm'/'3 petang' → 15:00, '9am' → 09:00, '10' after seeing slots → 10:00.\n"
        "- Always pass real values to tools — never pass placeholder text.\n"
        f"{custom_fields_rule}"
        f"{cancel_reschedule_rule}"
        f"{custom_tools_block}"
        "You are on WhatsApp. Keep replies concise — one question at a time, under 2 sentences.]"
    )


# Keys a clinic can't reuse for a custom field — the built-in property names
# (already collected via the core booking flow) plus the most likely aliases
# a clinic might type by mistake (e.g. "name" instead of realizing
# contact_name already covers it). Without this guard, a colliding custom
# field creates a second, differently-named property that means the same
# thing — the LLM can fill the "wrong" one, and book_appointment never gets
# a valid contact_name/contact_phone, so the booking (and the Sheets/Calendar
# sync that only happens once a booking actually succeeds) silently never
# completes.
_RESERVED_FIELD_KEYS = {
    "contact_name", "contact_phone", "service_type", "date", "time", "notes",
    "new_date", "new_time", "booking_id",
    "name", "phone", "phone_number", "full_name", "patient_name", "patient_phone",
}

# reschedule_appointment's new_date/new_time map onto the same "date"/"time"
# base field labels as book_appointment's date/time, just under different
# tool-argument names.
_RESCHEDULE_DATE_TIME_ALIAS = {"new_date": "date", "new_time": "time"}


def _tool_definitions_for_tenant(tenant) -> list:
    """
    Clone TOOL_DEFINITIONS, injecting this tenant's custom fields as extra
    optional properties on whichever tool each field is tagged for (each
    field belongs to exactly one action — book_appointment, cancel_appointment,
    or reschedule_appointment — matching how the AI actually calls one tool
    at a time), and relabelling the 5 fixed base fields (contact_name,
    contact_phone, service_type, date, time) with this tenant's own wording
    if configured. The JSON property key never changes — only its
    description — since book_appointment() and the bookings table depend on
    those exact keys. TOOL_DEFINITIONS itself is shared across all tenants
    and must never be mutated in place.
    """
    custom_fields = getattr(tenant, "custom_booking_fields", None) or []
    base_labels = getattr(tenant, "base_field_labels", None) or {}
    custom_tools = getattr(tenant, "custom_tools", None) or []
    if not custom_fields and not base_labels and not custom_tools:
        return TOOL_DEFINITIONS

    import copy
    tools = copy.deepcopy(TOOL_DEFINITIONS)
    for t in tools:
        tool_name = t["function"]["name"]
        props = t["function"]["parameters"]["properties"]

        for key, label in base_labels.items():
            if label and key in props and key in BASE_FIELD_HINTS:
                props[key]["description"] = f"{label} — {BASE_FIELD_HINTS[key]}"

        # reschedule_appointment uses new_date/new_time (distinct keys, to avoid
        # colliding with "the current appointment's" date/time mid-conversation)
        # — same underlying concept as book_appointment's date/time, so reuse
        # whatever label the clinic set for those.
        for prop_key, base_key in _RESCHEDULE_DATE_TIME_ALIAS.items():
            label = base_labels.get(base_key)
            if label and prop_key in props:
                props[prop_key]["description"] = f"New {label} — {BASE_FIELD_HINTS[base_key]}"

        for f in custom_fields:
            key = f.get("key")
            if not key or f.get("action", "book_appointment") != tool_name:
                continue
            if key in _RESERVED_FIELD_KEYS:
                logger.warning(
                    f"Skipping custom field '{key}' for tenant {getattr(tenant, 'tenant_id', '?')} — "
                    "collides with a built-in property, already collected automatically."
                )
                continue
            props[key] = {
                "type": "string",
                "description": f.get("instruction") or f.get("label") or key,
            }

    seen_keys = {t["function"]["name"] for t in tools}
    for ct in custom_tools:
        if not ct.get("enabled", True):
            continue
        tool_key = ct.get("tool_key")
        if not tool_key or tool_key in RESERVED_TOOL_NAMES or tool_key in seen_keys:
            logger.warning(
                f"Skipping custom tool '{tool_key}' for tenant {getattr(tenant, 'tenant_id', '?')} — "
                "missing or colliding with an existing tool name."
            )
            continue
        seen_keys.add(tool_key)
        tools.append({
            "type": "function",
            "function": {
                "name": tool_key,
                "description": ct.get("trigger_instruction") or ct.get("name") or tool_key,
                "parameters": {
                    "type": "object",
                    "properties": {
                        f["key"]: {
                            "type": "string",
                            "description": f.get("instruction") or f.get("label") or f["key"],
                        }
                        for f in ct.get("fields", []) if f.get("key")
                    },
                    "required": [],
                },
            },
        })
    return tools


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

    # Drop oversized messages before doing anything expensive
    if len(message_text) > _MAX_MSG_CHARS:
        logger.warning(
            f"Oversized message ({len(message_text)} chars) from {from_number} "
            f"tenant={tenant.tenant_id} — dropping"
        )
        try:
            await send_whatsapp_message(
                to=from_number,
                text="Sorry, your message is too long for me to process. Please send a shorter message.",
                phone_number_id=tenant.wa_phone_number_id,
                access_token=tenant.wa_access_token,
            )
        except Exception:
            pass
        return

    detected_lang = detect_language(message_text)
    formatted_phone = format_phone_number(from_number)

    # Rate limit: 5 messages per contact per 60 s, plus a coarser per-tenant
    # ceiling so many distinct senders can't collectively drive unbounded
    # LLM spend against one clinic's BYOK key.
    _rl_key = f"{tenant.tenant_id}:{formatted_phone}"
    if _is_rate_limited(_rl_key):
        logger.warning(f"Rate limited: {formatted_phone} tenant={tenant.tenant_id}")
        return
    if _is_tenant_rate_limited(tenant.tenant_id):
        logger.warning(f"Tenant-wide rate limited: tenant={tenant.tenant_id}")
        return

    # This whole setup phase (contact/thread lookup, opt-out check, guardrails,
    # feedback intercept, conversation-history build) runs before the LLM's own
    # try/except further below. Left unguarded, a failure anywhere here (a
    # transient DB error, a bug in the feedback-intercept call, etc.) would
    # propagate out of this background task and the patient would get total
    # silence — not even the LLM block's fallback reply, since we'd never
    # reach it. Catch broadly here too, so the worst case is still a reply.
    contact: dict = {}
    thread = None
    _save_inbound_task: Optional[asyncio.Task] = None
    try:
        # Neither call needs the other's result (thread lookup is keyed on
        # contact_number, not contact_id) — run them concurrently instead of
        # paying for two sequential round trips.
        contact_result, thread_result = await asyncio.gather(
            get_or_create_contact(
                tenant_id=tenant.tenant_id, phone=formatted_phone, source="whatsapp",
            ),
            _db(lambda: supabase.table("whatsapp_threads").select("*").eq(
                "tenant_id", tenant.tenant_id
            ).eq("contact_number", formatted_phone).order("created_at", desc=True).limit(1).execute()),
        )
        contact = contact_result.get("contact", {})

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

        # ── Opt-out / unsubscribe ──────────────────────────────────────────────
        if _OPT_OUT_RE.search(message_text):
            if contact.get("id"):
                _optcid = contact["id"]
                await _db(lambda: supabase.table("contacts").update(
                    {"opted_out": True}
                ).eq("id", _optcid).execute())
                await _log_contact_change(
                    tenant_id=tenant.tenant_id, contact_id=_optcid,
                    field="opted_out", old_value="false", new_value="true",
                )
            ack = _OPT_OUT_REPLIES.get(detected_lang, _OPT_OUT_REPLIES["en"])
            try:
                await send_whatsapp_message(
                    to=from_number, text=ack,
                    phone_number_id=tenant.wa_phone_number_id,
                    access_token=tenant.wa_access_token,
                )
            except Exception as _e:
                logger.warning(f"Opt-out ack failed: {_e}")
            logger.info(f"WA opt-out | tenant={tenant.tenant_id} | contact={contact.get('id')}")
            return

        # ── Guardrails ───────────────────────────────────────────────────────────
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

        # ── Feedback campaign intercept ─────────────────────────────────────────
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

        # Cap total history size sent to LLM at 50 KB to control token cost
        _MAX_HISTORY_BYTES = 50_000
        history_messages = history_result.data
        total_bytes = sum(len((m.get("body") or "").encode()) for m in history_messages)
        while history_messages and total_bytes > _MAX_HISTORY_BYTES:
            removed = history_messages.pop(0)
            total_bytes -= len((removed.get("body") or "").encode())

        conversation_history = [
            {"role": m["role"], "content": m["body"]} for m in history_messages
        ]
        conversation_history.append({"role": "user", "content": message_text})

        # This write is pure persistence/audit — conversation_history above
        # already has the message in memory, so nothing downstream needs to
        # wait for it. Start it now and let it run alongside the (much
        # slower) LLM call below instead of paying for it up front.
        _save_inbound_task = asyncio.create_task(_db(lambda: supabase.table("messages").insert({
            "thread_id": thread["id"],
            "tenant_id": tenant.tenant_id,
            "contact_id": contact.get("id"),
            "wa_message_id": message.get("id"),
            "role": "user",
            "body": message_text,
            "language": language,
            "handled_by": "ai",
        }).execute()))

        llm_client = load_llm_client(tenant)
        is_new_conversation = len(conversation_history) == 1
        date_context = _build_date_context(
            reply_language=getattr(tenant, "reply_language", "ask"),
            is_new_conversation=is_new_conversation,
            conversation_language=language,
            timezone=getattr(tenant, "timezone", "Asia/Kuala_Lumpur"),
            custom_booking_fields=getattr(tenant, "custom_booking_fields", None),
            base_field_labels=getattr(tenant, "base_field_labels", None),
            custom_tools=getattr(tenant, "custom_tools", None),
        )

        messages_payload = [
            {"role": "system", "content": tenant.system_prompt + date_context},
            *conversation_history,
        ]

        all_tools = [t for t in _tool_definitions_for_tenant(tenant) if tenant.tool_config.get(t["function"]["name"], True)]
        _custom_tool_keys = {
            ct["tool_key"] for ct in (getattr(tenant, "custom_tools", None) or [])
            if ct.get("enabled", True) and ct.get("tool_key")
        }
        enabled_tools = _select_tools(all_tools, history_messages, message_text, extra_always_on=_custom_tool_keys)
    except Exception as setup_err:
        logger.error(
            f"WA message setup failed | tenant={tenant.tenant_id} | from={from_number} | error={setup_err}",
            exc_info=True,
        )
        if _save_inbound_task is not None:
            _save_inbound_task.cancel()
        try:
            await send_whatsapp_message(
                to=from_number,
                text="Sorry, I'm having trouble responding right now. Our team will follow up with you shortly.",
                phone_number_id=tenant.wa_phone_number_id,
                access_token=tenant.wa_access_token,
            )
        except Exception:
            pass
        try:
            await escalate_to_human(
                tenant_id=tenant.tenant_id,
                reason="ai_error",
                context=f"WA message setup error: {setup_err}",
                source="whatsapp",
                contact_name=contact.get("name", ""),
                contact_phone=formatted_phone,
            )
        except Exception:
            pass
        return

    # This runs as a background task — the webhook already returned 200 to
    # Meta by now, so an uncaught exception here (missing/invalid LLM key,
    # provider outage, etc.) would silently die with no reply ever sent and
    # nothing visible anywhere in the dashboard. Fail loud into a fallback
    # reply + escalation instead of failing silent.
    try:
        has_date_mention = conversation_mentions_a_date(conversation_history)

        async def _execute(fn_name: str, args: dict) -> str:
            return await _execute_wa_tool(fn_name, args, tenant, contact, language, has_date_mention)

        result = await llm_client.run_with_tools(
            messages=messages_payload,
            tools=enabled_tools or None,
            execute_tool=_execute,
            parse_embedded_tool_calls=_parse_embedded_tool_calls,
        )
        reply_text = result.get("content") or "I'm sorry, I couldn't process that. Please try again or call us directly."
    except Exception as llm_err:
        logger.error(
            f"LLM generation failed | tenant={tenant.tenant_id} | provider={tenant.llm_config.get('provider')} | error={llm_err}",
            exc_info=True,
        )
        reply_text = "Sorry, I'm having trouble responding right now. Our team will follow up with you shortly."
        try:
            await escalate_to_human(
                tenant_id=tenant.tenant_id,
                reason="ai_error",
                context=f"LLM error: {llm_err}",
                source="whatsapp",
                contact_name=contact.get("name", ""),
                contact_phone=formatted_phone,
            )
        except Exception:
            pass

    if _save_inbound_task is not None:
        try:
            await _save_inbound_task
        except Exception as _save_err:
            logger.warning(f"Failed to persist inbound message (non-fatal): {_save_err}")

    thread_update: dict = {"last_message_at": datetime.now().isoformat(), "language": language}
    if contact.get("name"):
        thread_update["contact_name"] = contact["name"]

    # The patient only cares about the reply landing — neither DB write below
    # is needed to send it, so send it at the same time instead of making
    # them wait through two more round trips first.
    send_result, insert_result, update_result = await asyncio.gather(
        send_whatsapp_message(
            to=from_number,
            text=reply_text,
            phone_number_id=tenant.wa_phone_number_id,
            access_token=tenant.wa_access_token,
        ),
        _db(lambda: supabase.table("messages").insert({
            "thread_id": thread["id"],
            "tenant_id": tenant.tenant_id,
            "contact_id": contact.get("id"),
            "role": "assistant",
            "body": reply_text,
            "language": language,
            "handled_by": "ai",
        }).execute()),
        _db(lambda: supabase.table("whatsapp_threads").update(thread_update).eq(
            "id", thread["id"]
        ).execute()),
        return_exceptions=True,
    )
    if isinstance(send_result, Exception):
        logger.error(
            f"SEND FAILED | tenant={tenant.tenant_id} | to={from_number} | "
            f"phone_id={tenant.wa_phone_number_id} | error={send_result}"
        )
    else:
        logger.info(f"Reply sent OK to={from_number} tenant={tenant.tenant_id}")
    if isinstance(insert_result, Exception):
        logger.warning(f"Failed to save assistant message (non-fatal): {insert_result}")
    if isinstance(update_result, Exception):
        logger.warning(f"Failed to update thread (non-fatal): {update_result}")


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
        timezone=getattr(tenant, "timezone", "Asia/Kuala_Lumpur"),
        custom_booking_fields=getattr(tenant, "custom_booking_fields", None),
        base_field_labels=getattr(tenant, "base_field_labels", None),
        custom_tools=getattr(tenant, "custom_tools", None),
    )
    messages_payload = [
        {"role": "system", "content": tenant.system_prompt + date_context},
        *conversation_history,
    ]
    all_tools = [t for t in _tool_definitions_for_tenant(tenant) if tenant.tool_config.get(t["function"]["name"], True)]
    _custom_tool_keys = {
        ct["tool_key"] for ct in (getattr(tenant, "custom_tools", None) or [])
        if ct.get("enabled", True) and ct.get("tool_key")
    }
    enabled_tools = _select_tools(all_tools, history.data, transcript, extra_always_on=_custom_tool_keys)

    try:
        has_date_mention = conversation_mentions_a_date(conversation_history)

        async def _execute(fn_name: str, args: dict) -> str:
            return await _execute_wa_tool(fn_name, args, tenant, contact, language, has_date_mention)

        result = await llm_client.run_with_tools(
            messages=messages_payload,
            tools=enabled_tools or None,
            execute_tool=_execute,
            parse_embedded_tool_calls=_parse_embedded_tool_calls,
        )
        reply_text = result.get("content") or "I'm sorry, I couldn't process that. Please try again."
    except Exception as llm_err:
        logger.error(
            f"LLM generation failed (voice) | tenant={tenant.tenant_id} | provider={tenant.llm_config.get('provider')} | error={llm_err}",
            exc_info=True,
        )
        reply_text = "Sorry, I'm having trouble responding right now. Our team will follow up with you shortly."
        try:
            await escalate_to_human(
                tenant_id=tenant.tenant_id,
                reason="ai_error",
                context=f"LLM error: {llm_err}",
                source="whatsapp",
                contact_name=contact.get("name", ""),
                contact_phone=formatted_phone,
            )
        except Exception:
            pass

    voice_enabled = getattr(tenant, "voice_reply_enabled", False)
    tts_provider = getattr(tenant, "voice_tts_provider", "openai") or "openai"
    tts_voice_map = getattr(tenant, "voice_tts_voice_map", None) or {}
    provider_defaults = DEFAULT_TTS_VOICE_MAP.get(tts_provider, DEFAULT_TTS_VOICE_MAP["openai"])
    tts_voice = tts_voice_map.get(language) or provider_defaults.get(language) or provider_defaults["en"]

    if voice_enabled:
        try:
            ogg_bytes = await _generate_tts_ogg(reply_text, tts_provider, tts_voice, tenant)
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

# Substring checks against the model's own (paraphrased) reply text — kept
# as short, literal phrases rather than single words to avoid false
# positives, but covering both word orders a model commonly uses
# ("available slot(s)" vs "slot is/are available").
_SLOT_MARKERS = (
    "available times", "available time", "available slot",
    "slot is available", "slots are available",
    "time is available", "times are available",
    "masa yang tersedia", "tersedia pada",
    "可用时间", "有空",
    "pilih masa",
)
_CANCEL_KEYWORDS = ("cancel", "batal", "batalkan", "tak jadi", "cancel", "取消")
_RESCHEDULE_KEYWORDS = ("reschedule", "tukar masa", "ubah masa", "move", "change appointment", "改期", "tangguh")
_ALWAYS_ON = {"get_faq", "escalate_to_human", "lookup_patient"}


def _select_tools(all_tools: list, history_messages: list, current_text: str, extra_always_on: set = frozenset()) -> list:
    all_text = " ".join(m["body"].lower() for m in history_messages) + " " + current_text.lower()
    assistant_text = " ".join(m["body"].lower() for m in history_messages if m["role"] == "assistant")

    slots_shown = any(marker in assistant_text for marker in _SLOT_MARKERS)
    wants_cancel = any(kw in all_text for kw in _CANCEL_KEYWORDS)
    wants_reschedule = any(kw in all_text for kw in _RESCHEDULE_KEYWORDS)

    # extra_always_on carries this tenant's own custom tool keys, which
    # can't be baked into the module-level _ALWAYS_ON set since they're
    # per-tenant and unknown ahead of time.
    allowed: set[str] = set(_ALWAYS_ON) | set(extra_always_on)

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

async def _execute_wa_tool(fn_name: str, args: dict, tenant, contact: dict, language: str, has_date_mention: bool) -> str:
    """
    Execute a single WhatsApp tool call and return its result text.

    Called once per tool call from LLMClient.run_with_tools, which feeds this
    text back to the LLM so it can react to it (ask the next question,
    confirm, etc.) in a follow-up turn instead of this string being the
    entire bot reply.
    """
    from api.agent import _resolve_datetime

    # A model that skips asking and just guesses a date (usually "tomorrow")
    # still produces a normal-looking YYYY-MM-DD argument, so the tool call
    # itself can't be distinguished from a legitimate one — check the actual
    # conversation text for a date-shaped mention instead of trusting the arg.
    if fn_name in ("book_appointment", "check_slots") and not has_date_mention:
        if language == "ms":
            return "Tarikh berapa yang anda mahu untuk temujanji ini?"
        elif language == "zh":
            return "请问您希望预约哪一天？"
        else:
            return "What date would you like for this appointment?"

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
                return f"Saya masih perlukan: {missing_str}."
            elif language == "zh":
                return f"还需要以下信息：{missing_str}。"
            else:
                return f"I still need: {missing_str}."

        scheduled_dt = _resolve_datetime(args.get("date", ""), args.get("time", ""))
        if not scheduled_dt:
            if language == "ms":
                return "Saya tidak faham tarikh/masa. Boleh nyatakan semula?"
            else:
                return "I couldn't understand the date and time. Please clarify."

        custom_fields = {
            f["key"]: args[f["key"]]
            for f in (getattr(tenant, "custom_booking_fields", None) or [])
            if f.get("action", "book_appointment") == "book_appointment" and f.get("key") and args.get(f["key"])
        }

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
            custom_fields=custom_fields or None,
        )
        if result["success"]:
            # Update contact record so appointments dashboard shows real name
            existing_name = (contact.get("name") or "").strip().lower()
            if contact_name and existing_name in ("", "unknown"):
                try:
                    supabase = get_supabase_client()
                    _cid = contact.get("id")
                    _safe_name = contact_name[:100]
                    await _db(lambda: supabase.table("contacts").update(
                        {"name": _safe_name}
                    ).eq("id", _cid).execute())
                    await _log_contact_change(
                        tenant_id=tenant.tenant_id, contact_id=_cid,
                        field="name", old_value=existing_name, new_value=_safe_name,
                    )
                    contact["name"] = _safe_name
                except Exception as _e:
                    logger.warning(f"Failed to update contact name: {_e}")

            svc = args.get("service_type", "")
            date_ = args.get("date", "")
            time_ = args.get("time", "")
            if language == "ms":
                return f"Berjaya! Temujanji {svc} anda telah ditetapkan pada {date_} jam {time_}."
            elif language == "zh":
                return f"成功！您的{svc}预约已定于{date_} {time_}。"
            else:
                return f"Done! Your {svc} appointment is booked for {date_} at {time_}."
        else:
            msg = result.get("message", "")
            if language == "ms":
                return msg or "Maaf, penempahan tidak berjaya. Sila cuba lagi."
            elif language == "zh":
                return msg or "抱歉，预约未能完成，请再试一次。"
            else:
                return msg or "Sorry, I couldn't complete that booking."

    elif fn_name == "check_slots":
        try:
            date_obj = datetime.strptime(args["date"], "%Y-%m-%d")
        except (ValueError, KeyError):
            if language == "ms":
                return "Sila berikan tarikh yang tepat."
            else:
                return "Please provide the date in YYYY-MM-DD format."
        result = await check_slots(
            tenant_id=tenant.tenant_id,
            service_type=args.get("service_type", "checkup"),
            date=date_obj,
            tenant_config=tenant,
        )
        if result["success"] and result["available_slots"]:
            slots = ", ".join(s["time"] for s in result["available_slots"][:5])
            if language == "ms":
                return f"Masa yang tersedia pada {args['date']}: {slots}\nPilih masa yang sesuai untuk anda."
            elif language == "zh":
                return f"{args['date']} 的可用时间：{slots}\n请选择您方便的时间。"
            else:
                return f"Available times on {args['date']}: {slots}\nWhich time works for you?"
        else:
            if language == "ms":
                return f"Tiada masa yang tersedia pada {args['date']}. Cuba tarikh lain?"
            elif language == "zh":
                return f"{args['date']} 没有可用时间，请尝试其他日期。"
            else:
                return f"No available slots on {args['date']}. Try another date?"

    elif fn_name == "cancel_appointment":
        cancel_custom_fields = {
            f["key"]: args[f["key"]]
            for f in (getattr(tenant, "custom_booking_fields", None) or [])
            if f.get("action") == "cancel_appointment" and f.get("key") and args.get(f["key"])
        }
        result = await cancel_appointment(
            tenant_id=tenant.tenant_id,
            contact_id=contact.get("id"),
            booking_id=args.get("booking_id"),
            custom_fields=cancel_custom_fields or None,
        )
        if result["success"]:
            from datetime import datetime as dt
            t = dt.fromisoformat(result["scheduled_at"]).strftime("%d %b, %I:%M %p")
            if language == "ms":
                return f"Temujanji anda pada {t} telah dibatalkan."
            elif language == "zh":
                return f"您在{t}的预约已取消。"
            else:
                return f"Your appointment on {t} has been cancelled."
        else:
            msg = result.get("message", "")
            if language == "ms":
                return msg or "Saya tidak dapat mencari temujanji tersebut."
            else:
                return msg or "I couldn't find that appointment."

    elif fn_name == "reschedule_appointment":
        reschedule_custom_fields = {
            f["key"]: args[f["key"]]
            for f in (getattr(tenant, "custom_booking_fields", None) or [])
            if f.get("action") == "reschedule_appointment" and f.get("key") and args.get(f["key"])
        }
        result = await reschedule_appointment(
            tenant_id=tenant.tenant_id,
            contact_id=contact.get("id"),
            new_date=args.get("new_date", ""),
            new_time=args.get("new_time", ""),
            booking_id=args.get("booking_id"),
            custom_fields=reschedule_custom_fields or None,
            tenant_config=tenant,
        )
        if result["success"]:
            from datetime import datetime as dt
            new = dt.fromisoformat(result["new_time"]).strftime("%d %b, %I:%M %p")
            if language == "ms":
                return f"Berjaya ditukar! Temujanji baru anda pada {new}."
            elif language == "zh":
                return f"改期成功！您的新预约时间是{new}。"
            else:
                return f"Rescheduled! Your new appointment is on {new}."
        else:
            err = result.get("error", "")
            if language == "ms":
                return err or "Tidak dapat menukar temujanji. Sila hubungi kami."
            else:
                return err or "Couldn't reschedule that appointment."

    elif fn_name == "lookup_patient":
        phone = args.get("contact_phone", "")
        if not phone:
            if language == "ms":
                return "Boleh kongsikan nombor telefon anda?"
            elif language == "zh":
                return "请问您的电话号码是？"
            else:
                return "Could you share your phone number?"
        result = await lookup_patient(tenant_id=tenant.tenant_id, phone=phone)
        if not result.get("found"):
            if language == "ms":
                return "Tiada rekod pesakit sedia ada dijumpai untuk nombor ini — layan sebagai pesakit baru."
            elif language == "zh":
                return "未找到该号码的现有病人记录——请作为新病人处理。"
            else:
                return "No existing patient record found for this number — treat them as a new patient."
        last = result.get("last_booking")
        last_str = f", last visit: {last['service_type']} on {last['scheduled_at'][:10]}" if last else ""
        name_on_file = result.get("name") or "no name on file"
        if language == "ms":
            return f"Pesakit sedia ada dijumpai — nama dalam rekod: {name_on_file}{last_str}."
        elif language == "zh":
            return f"找到现有病人记录——档案姓名：{name_on_file}{last_str}。"
        else:
            return f"Existing patient found — name on file: {name_on_file}{last_str}."

    elif fn_name == "get_faq":
        result = await get_faq(tenant, args.get("question", ""))
        if result["success"]:
            return result["answer"]
        else:
            return "I don't have that information. Please contact us directly."

    elif fn_name == "escalate_to_human":
        await escalate_to_human(
            tenant_id=tenant.tenant_id,
            reason=args.get("reason", "user_requested"),
            context="WA tool escalation",
            source="whatsapp",
            contact_name=contact.get("name", ""),
            contact_phone=contact.get("phone", ""),
        )
        return "I'm connecting you with one of our staff members now. They'll be in touch shortly."

    ct = next(
        (c for c in (getattr(tenant, "custom_tools", None) or []) if c.get("tool_key") == fn_name),
        None,
    )
    if ct:
        await run_custom_tool(tenant.tenant_id, contact, ct, args)
        ct_name = ct.get("name", fn_name)
        if language == "ms":
            return f"Baik, terima kasih! Butiran {ct_name} anda telah direkodkan."
        elif language == "zh":
            return f"好的，谢谢！您的{ct_name}信息已记录。"
        else:
            return f"Got it, thanks! I've recorded your {ct_name} details."

    return ""


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
        contact_name=contact.get("name", ""),
        contact_phone=contact.get("phone", ""),
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

@router.post("/whatsapp/validate-credentials/{tenant_id}", dependencies=[Depends(require_internal_secret)])
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

@router.post("/whatsapp/test-send/{tenant_id}", dependencies=[Depends(require_internal_secret)])
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
