"""
Tenant Configuration Loader
Loads clinic settings from Supabase on every call/message.
"""

import os
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, List
from supabase import create_client, Client


def get_supabase_client() -> Client:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
    return create_client(url, key)


def _default_system_prompt(clinic_name: str, agent_name: str = "Maya") -> str:
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


@dataclass
class TenantConfig:
    tenant_id: str
    name: str
    agent_name: str = "Maya"
    system_prompt: str = ""
    stt_config: Dict[str, Any] = field(default_factory=dict)
    llm_config: Dict[str, Any] = field(default_factory=dict)
    tts_config: Dict[str, Any] = field(default_factory=dict)
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
    # Per-tenant provider API keys (set by clinic in dashboard, stored encrypted in Supabase)
    # Structure: {"openai": {"api_key": "..."}, "deepgram": {"api_key": "..."}, ...}
    provider_credentials: Dict[str, Any] = field(default_factory=dict)
    # Voice reply settings for WhatsApp
    voice_reply_enabled: bool = False
    voice_stt_provider: str = "openai"
    voice_tts_voice: str = "nova"

    def __post_init__(self):
        if not self.system_prompt:
            self.system_prompt = _default_system_prompt(self.name, self.agent_name)
        if not self.stt_config:
            self.stt_config = {"en": "deepgram", "ms": "openai", "zh": "openai"}
        if not self.llm_config:
            self.llm_config = {"provider": "openai", "model": "gpt-4o"}
        if not self.tts_config:
            self.tts_config = {"en": "cartesia", "ms": "cartesia", "zh": "cartesia"}
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
    return TenantConfig(
        tenant_id=str(tenant_row["id"]),
        name=tenant_row["name"],
        # agent_name lives in tenant_settings, not tenants
        agent_name=settings.get("agent_name") or tenant_row.get("agent_name", "Maya"),
        system_prompt=settings.get("system_prompt", ""),
        stt_config=settings.get("stt_config") or {},
        llm_config=settings.get("llm_config") or {},
        tts_config=settings.get("tts_config") or {},
        business_hours=settings.get("business_hours") or {},
        faq=settings.get("faq") or [],
        tool_config=settings.get("tool_config") or {},
        # default_language lives in tenants table
        default_language=tenant_row.get("default_language", "en"),
        is_active=tenant_row.get("is_active", True),
        escalation_number=tenant_row.get("escalation_number"),
        wa_phone_number_id=tenant_row.get("wa_phone_number_id"),
        wa_access_token=tenant_row.get("wa_access_token"),
        wa_verify_token=tenant_row.get("wa_verify_token"),
        google_calendar_id=settings.get("google_calendar_id"),
        google_sheets_id=settings.get("google_sheets_id"),
        provider_credentials=settings.get("provider_credentials") or {},
        voice_reply_enabled=bool(settings.get("voice_reply_enabled", False)),
        voice_stt_provider=settings.get("voice_stt_provider") or "openai",
        voice_tts_voice=settings.get("voice_tts_voice") or "nova",
    )


async def get_tenant_by_sip_uri(sip_uri: str) -> Optional[TenantConfig]:
    """Load tenant config by the SIP destination number/URI."""
    try:
        supabase = get_supabase_client()

        number = sip_uri.replace("sip:", "").split("@")[0].strip()

        result = supabase.table("tenants").select("*").eq(
            "sip_uri", number
        ).eq("is_active", True).maybe_single().execute()

        if not result.data:
            return None

        settings_result = supabase.table("tenant_settings").select("*").eq(
            "tenant_id", result.data["id"]
        ).maybe_single().execute()

        return _build_tenant_from_rows(result.data, settings_result.data or {})
    except Exception:
        return None


async def get_tenant_by_wa_phone_id(phone_number_id: str) -> Optional[TenantConfig]:
    """Load tenant config by WhatsApp phone_number_id."""
    try:
        supabase = get_supabase_client()

        result = supabase.table("tenants").select("*").eq(
            "wa_phone_number_id", phone_number_id
        ).eq("is_active", True).maybe_single().execute()

        if not result.data:
            return None

        settings_result = supabase.table("tenant_settings").select("*").eq(
            "tenant_id", result.data["id"]
        ).maybe_single().execute()

        return _build_tenant_from_rows(result.data, settings_result.data or {})
    except Exception:
        return None


async def get_tenant_by_id(tenant_id: str) -> Optional[TenantConfig]:
    """Load tenant config by tenant UUID."""
    try:
        supabase = get_supabase_client()

        result = supabase.table("tenants").select("*").eq(
            "id", tenant_id
        ).maybe_single().execute()

        if not result.data:
            return None

        settings_result = supabase.table("tenant_settings").select("*").eq(
            "tenant_id", tenant_id
        ).maybe_single().execute()

        return _build_tenant_from_rows(result.data, settings_result.data or {})
    except Exception:
        return None
