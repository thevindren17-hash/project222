"""
Tenant Configuration Loader
Singleton Supabase client, async thread-pool wrapper, and 60-second tenant cache.
"""

import os
import time
import asyncio
import threading
import logging
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, List, Tuple
from supabase import create_client, Client

_logger = logging.getLogger(__name__)

# Prefix marking a provider_credentials value as pgcrypto-encrypted (see
# backend/migrations/005_encrypt_credentials.sql). Values without this
# prefix are legacy plaintext, kept working until re-saved.
_ENC_PREFIX = "enc:v1:"


# ── Singleton client (one connection pool for the whole process) ───────────────
_client: Optional[Client] = None
_client_lock = threading.Lock()


def get_supabase_client() -> Client:
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                url = os.getenv("SUPABASE_URL")
                key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
                if not url or not key:
                    raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
                _client = create_client(url, key)
    return _client


async def _db(fn, timeout: float = 10.0):
    """
    Run a synchronous Supabase call in a thread pool so it never blocks the
    event loop. Raises RuntimeError if the call takes longer than *timeout* seconds
    — prevents a hung DB connection from stalling an entire background task.
    """
    try:
        return await asyncio.wait_for(asyncio.to_thread(fn), timeout=timeout)
    except asyncio.TimeoutError:
        raise RuntimeError(f"Supabase call timed out after {timeout}s")


class _EmptyResult:
    """Mimics a Supabase response object with no matching row."""
    data = None


async def _db_optional(fn, timeout: float = 10.0):
    """
    Like _db(), but for queries ending in .maybe_single() — PostgREST returns
    a 406 ("PGRST116: JSON object requested, multiple (or no) rows returned")
    when a maybe_single() query matches zero rows. Depending on the
    supabase-py/postgrest-py version this either raises that as an
    exception, OR returns bare None instead of a response object — both
    observed in production logs for this project. Since "no row found" is
    the normal, expected outcome for most of these lookups (an opted-out
    contact, a new contact with no campaign yet, a cancelled booking, etc.),
    normalize either case to an empty result instead of a crash. Any other
    error still propagates normally.
    """
    try:
        result = await _db(fn, timeout)
    except Exception as e:
        msg = str(e)
        if "PGRST116" in msg or "Not Acceptable" in msg:
            return _EmptyResult()
        raise
    return result if result is not None else _EmptyResult()


# ── Tenant config cache (60 s TTL — settings rarely change) ───────────────────
_tenant_cache: Dict[str, Tuple["TenantConfig", float]] = {}
_cache_lock = threading.Lock()
_CACHE_TTL = 60.0


def invalidate_tenant_cache(tenant_id: Optional[str] = None) -> None:
    """Bust cache after a settings save so the next request picks up new values."""
    with _cache_lock:
        if tenant_id:
            _tenant_cache.pop(tenant_id, None)
        else:
            _tenant_cache.clear()


def _cache_get(key: str) -> Optional["TenantConfig"]:
    with _cache_lock:
        entry = _tenant_cache.get(key)
        if entry and time.monotonic() - entry[1] < _CACHE_TTL:
            return entry[0]
    return None


def _cache_set(key: str, config: "TenantConfig") -> None:
    with _cache_lock:
        _tenant_cache[key] = (config, time.monotonic())


# ── Core agent rules ───────────────────────────────────────────────────────────
# Mandatory, always sent to the LLM regardless of what a clinic writes in
# their custom_instructions. Clinics can add tone/services/notes on top of
# this, but can never remove or override booking flow, escalation triggers,
# or safety boundaries (no medical advice, no exact pricing, etc.) — those
# are the platform's guarantee, not something a clinic's own prompt can drop.

def _core_agent_rules(clinic_name: str, agent_name: str = "Maya") -> str:
    return f"""You are {agent_name}, an AI receptionist for {clinic_name}.

Your job:
- Book, reschedule, and cancel appointments
- Answer questions about clinic hours, location, services, and pricing
- Check doctor/dentist availability
- Take messages for staff
- Transfer to a human when requested or when you cannot help

You must never:
- Give medical or dental advice
- Diagnose any condition
- Confirm exact prices (say 'please contact us for pricing')
- Make up information not in your tools or FAQ
- Book appointments in the past
- Book outside of business hours without confirming
- Promise specific doctors unless confirmed via tools

CONVERSATION GUARDRAILS:

1. GREETING: Keep it brief (under 15 words). Don't list all services upfront.
   Good: "Hello, you've reached {clinic_name}. How can I help you today?"
   Bad: "Hello! Welcome to {clinic_name}. We offer scaling, checkup, whitening, extraction..."

2. RESPONSES: Be concise. One action per response. Maximum 2 sentences.
   Good: "I can book that for you. Which date works best?"
   Bad: "Absolutely! I'd be delighted to help you schedule an appointment. We have various time slots available..."

3. CONFIRMATIONS: Always repeat back critical details before finalizing.
   "Just to confirm: scaling appointment on May 15 at 2 PM. Is that correct?"

4. AMBIGUITY: Ask ONE clarifying question at a time.
   Good: "Which service do you need - checkup or cleaning?"
   Bad: "What service do you need? And what date? And what time? And which doctor?"

5. SILENCE/UNCLEAR: After 2 unclear responses, offer human transfer.
   "I'm having trouble understanding. Would you like me to connect you with someone?"

6. ESCALATION TRIGGERS (immediate transfer):
   - Patient says: "speak to someone", "human", "staff", "manager", "doctor"
   - Emergency keywords: "pain", "emergency", "urgent", "bleeding", "swelling", "broken tooth"
   - Patient is frustrated (repeating themselves 3+ times)
   - You cannot help after 2 attempts
   - Complaint or refund request

7. SAFETY BOUNDARIES:
   - Don't book more than 3 appointments in one conversation
   - Don't accept bookings more than 3 months out
   - Don't cancel appointments scheduled within 2 hours (say "For cancellations this close to your appointment, please call us")
   - Don't book before 7 AM or after 10 PM

8. PROHIBITED TOPICS:
   - Medical advice: "I can't provide medical advice. Please consult our dentist."
   - Specific pricing: "For accurate pricing, please contact us directly."
   - Insurance claims: "Our staff can help you with that. Let me transfer you."
   - Complaints: "I understand your frustration. Let me connect you with someone who can help resolve this."
   - Legal questions: "I'm not qualified to answer that. Let me transfer you."

9. DATA PRIVACY:
   - Never ask for IC/NRIC numbers, credit card details, passwords, or medical history
   - Never read back full phone numbers (confirm last 4 digits only)
   - Never share information about other patients
   - Never confirm appointments for someone else without verification

10. NATURAL CONVERSATION:
   - Use contractions: "I'll" not "I will", "you're" not "you are"
   - Acknowledge naturally: "Got it", "Perfect", "I understand", "Okay"
   - No robotic phrases: use "How can I help?" not "How may I assist you today"
   - No over-apologizing: "Sorry about that" not "I sincerely apologize for any inconvenience"
   - Match patient's energy: casual or professional as appropriate

11. LANGUAGE SWITCHING:
   - Respond in the language the patient uses
   - If patient switches mid-conversation, switch immediately
   - Supported: English, Bahasa Melayu, Mandarin Chinese

12. TIME AWARENESS:
   - If patient calls outside business hours: "We're currently closed. Our hours are [hours]. Would you like to book for when we're open?"
   - Don't offer same-day appointments after 4 PM
   - For urgent requests outside hours: "This sounds urgent. Our emergency line is [number]."

13. ERROR RECOVERY:
   - If a tool fails, never say "system error" or expose technical details
   - Instead: "I'm having trouble with that. Let me transfer you to someone who can help."

14. CONVERSATION LENGTH:
   - Target: Complete booking in under 2 minutes
   - If conversation exceeds 10 turns without progress, offer transfer

IMMEDIATE ESCALATION PHRASES (in any language):
- English: "speak to someone", "talk to a person", "human", "staff", "real person", "not working", "frustrated"
- Bahasa Melayu: "cakap dengan orang", "jumpa staff", "tak faham", "tak betul"
- Chinese: "转人工", "找人", "真人", "客服"
"""


# ── TenantConfig dataclass ────────────────────────────────────────────────────

@dataclass
class TenantConfig:
    tenant_id: str
    name: str
    agent_name: str = "Maya"
    system_prompt: str = ""  # always core rules + custom_instructions — see _build_tenant_from_rows
    custom_instructions: str = ""
    llm_config: Dict[str, Any] = field(default_factory=dict)
    business_hours: Dict[str, Any] = field(default_factory=dict)
    faq: List[Dict[str, str]] = field(default_factory=list)
    tool_config: Dict[str, bool] = field(default_factory=dict)
    default_language: str = "en"
    is_active: bool = True
    escalation_number: Optional[str] = None
    wa_phone_number_id: Optional[str] = None
    wa_access_token: Optional[str] = None
    wa_verify_token: Optional[str] = None
    google_calendar_id: Optional[str] = None
    google_sheets_id: Optional[str] = None
    google_sheets_tab: Optional[str] = None
    provider_credentials: Dict[str, Any] = field(default_factory=dict)
    voice_reply_enabled: bool = False
    voice_stt_provider: str = "openai"
    voice_tts_provider: str = "openai"
    voice_tts_voice_map: Dict[str, str] = field(default_factory=dict)
    reply_language: str = "ask"
    reminder_1d_enabled: bool = False
    reminder_3h_enabled: bool = False
    reminder_1d_template: str = ""
    reminder_3h_template: str = ""
    timezone: str = "Asia/Kuala_Lumpur"
    custom_booking_fields: List[Dict[str, str]] = field(default_factory=list)

    def __post_init__(self):
        if not self.system_prompt:
            self.system_prompt = _core_agent_rules(self.name, self.agent_name)
        if not self.llm_config:
            self.llm_config = {"provider": "openai", "model": "gpt-4o"}
        if not self.business_hours:
            self.business_hours = {
                "mon": {"open": "09:00", "close": "18:00"},
                "tue": {"open": "09:00", "close": "18:00"},
                "wed": {"open": "09:00", "close": "18:00"},
                "thu": {"open": "09:00", "close": "18:00"},
                "fri": {"open": "09:00", "close": "18:00"},
                "sat": {"open": "09:00", "close": "13:00"},
                "sun": {"closed": True},
            }


def _build_tenant_from_rows(tenant_row: dict, settings_row: dict) -> TenantConfig:
    settings = settings_row or {}
    name = tenant_row["name"]
    agent_name = settings.get("agent_name") or tenant_row.get("agent_name", "Maya")

    custom_instructions = settings.get("custom_instructions")
    if custom_instructions is None:
        # Back-compat: a clinic may have a pre-migration fully-custom prompt
        # saved under the old system_prompt column. Fold it in once as their
        # "custom" layer rather than losing it — it now sits on top of the
        # mandatory core rules instead of replacing them.
        custom_instructions = settings.get("system_prompt") or ""

    core = _core_agent_rules(name, agent_name)
    full_prompt = (
        core if not custom_instructions.strip()
        else f"{core}\n\nCLINIC-SPECIFIC NOTES (from {name}, on top of the rules above):\n{custom_instructions.strip()}"
    )

    return TenantConfig(
        tenant_id=str(tenant_row["id"]),
        name=name,
        agent_name=agent_name,
        system_prompt=full_prompt,
        custom_instructions=custom_instructions,
        llm_config=settings.get("llm_config") or {},
        business_hours=settings.get("business_hours") or {},
        faq=settings.get("faq") or [],
        tool_config=settings.get("tool_config") or {},
        default_language=tenant_row.get("default_language", "en"),
        is_active=tenant_row.get("is_active", True),
        escalation_number=tenant_row.get("escalation_number"),
        wa_phone_number_id=tenant_row.get("wa_phone_number_id"),
        wa_access_token=tenant_row.get("wa_access_token"),
        wa_verify_token=tenant_row.get("wa_verify_token"),
        google_calendar_id=settings.get("google_calendar_id"),
        google_sheets_id=settings.get("google_sheets_id"),
        google_sheets_tab=settings.get("google_sheets_tab"),
        provider_credentials=settings.get("provider_credentials") or {},
        voice_reply_enabled=bool(settings.get("voice_reply_enabled", False)),
        voice_stt_provider=settings.get("voice_stt_provider") or "openai",
        voice_tts_provider=settings.get("voice_tts_provider") or "openai",
        voice_tts_voice_map=settings.get("voice_tts_voice_map") or {},
        reply_language=settings.get("reply_language") or "ask",
        reminder_1d_enabled=bool(settings.get("reminder_1d_enabled", False)),
        reminder_3h_enabled=bool(settings.get("reminder_3h_enabled", False)),
        reminder_1d_template=settings.get("reminder_1d_template") or "",
        reminder_3h_template=settings.get("reminder_3h_template") or "",
        timezone=settings.get("timezone") or "Asia/Kuala_Lumpur",
        custom_booking_fields=settings.get("custom_booking_fields") or [],
    )


async def _decrypt_provider_credentials(raw: Dict[str, Any]) -> Dict[str, Any]:
    """
    Decrypt any 'enc:v1:'-prefixed BYOK credential values. Runs once per
    tenant load (results are cached for _CACHE_TTL seconds), not per-request,
    so this adds at most one extra DB round trip every 60s per active tenant.
    """
    if not raw or not os.getenv("CREDENTIAL_ENCRYPTION_KEY"):
        return raw
    enc_key = os.getenv("CREDENTIAL_ENCRYPTION_KEY", "")
    supabase = get_supabase_client()
    decrypted: Dict[str, Any] = {}
    for provider, fields in raw.items():
        if not isinstance(fields, dict):
            decrypted[provider] = fields
            continue
        new_fields = dict(fields)
        for k, v in fields.items():
            if isinstance(v, str) and v.startswith(_ENC_PREFIX):
                ciphertext = v[len(_ENC_PREFIX):]
                try:
                    result = await _db(lambda ct=ciphertext: supabase.rpc(
                        "decrypt_credential", {"ciphertext": ct, "key": enc_key}
                    ).execute())
                    new_fields[k] = result.data
                except Exception as exc:
                    _logger.error(f"Failed to decrypt {provider}.{k}: {exc}")
                    new_fields[k] = None
        decrypted[provider] = new_fields
    return decrypted


# ── Tenant loaders (async, cached) ────────────────────────────────────────────

async def get_tenant_by_wa_phone_id(phone_number_id: str) -> Optional[TenantConfig]:
    cache_key = f"wa:{phone_number_id}"
    cached = _cache_get(cache_key)
    if cached:
        return cached
    try:
        supabase = get_supabase_client()
        result = await _db_optional(lambda: supabase.table("tenants").select("*").eq(
            "wa_phone_number_id", phone_number_id
        ).eq("is_active", True).maybe_single().execute())
        if not result.data:
            return None
        settings_result = await _db_optional(lambda: supabase.table("tenant_settings").select("*").eq(
            "tenant_id", result.data["id"]
        ).maybe_single().execute())
        config = _build_tenant_from_rows(result.data, settings_result.data or {})
        config.provider_credentials = await _decrypt_provider_credentials(config.provider_credentials)
        _cache_set(cache_key, config)
        _cache_set(str(result.data["id"]), config)
        return config
    except Exception as e:
        # Logged, not just swallowed — otherwise this looks identical to
        # "tenant doesn't exist" everywhere downstream (e.g. whatsapp.py's
        # generic "Unknown or inactive tenant" warning) and the real cause
        # (bad JSON in tenant_settings, a credential-decrypt failure, etc.)
        # is lost forever.
        _logger.error(f"get_tenant_by_wa_phone_id failed for phone_number_id={phone_number_id}: {e}", exc_info=True)
        return None


async def get_tenant_by_id(tenant_id: str) -> Optional[TenantConfig]:
    cached = _cache_get(tenant_id)
    if cached:
        return cached
    try:
        supabase = get_supabase_client()
        result = await _db_optional(lambda: supabase.table("tenants").select("*").eq(
            "id", tenant_id
        ).maybe_single().execute())
        if not result.data:
            return None
        settings_result = await _db_optional(lambda: supabase.table("tenant_settings").select("*").eq(
            "tenant_id", tenant_id
        ).maybe_single().execute())
        config = _build_tenant_from_rows(result.data, settings_result.data or {})
        config.provider_credentials = await _decrypt_provider_credentials(config.provider_credentials)
        _cache_set(tenant_id, config)
        return config
    except Exception as e:
        _logger.error(f"get_tenant_by_id failed for tenant_id={tenant_id}: {e}", exc_info=True)
        return None
