"""
Provider Factory — Dynamic STT / LLM / TTS loading based on tenant config.

All API keys come from the tenant's provider_credentials stored in Supabase.
Clinics add their own keys in the dashboard — zero platform-level AI keys needed.

Voice pipeline (LiveKit):  load_tenant_providers(tenant) → (stt, llm, tts)
Text pipeline (WhatsApp):  load_llm_client(tenant)       → LLMClient.generate()
"""

import os
from typing import Any, Optional, Tuple, List, Dict

# ── LiveKit plugins ────────────────────────────────────────────────────────────
from livekit.plugins import openai as lk_openai
from livekit.plugins import silero

try:
    from livekit.plugins import deepgram as lk_deepgram
    HAS_DEEPGRAM = True
except ImportError:
    HAS_DEEPGRAM = False

try:
    from livekit.plugins import cartesia as lk_cartesia
    HAS_CARTESIA = True
except ImportError:
    HAS_CARTESIA = False

try:
    from livekit.plugins import elevenlabs as lk_elevenlabs
    HAS_ELEVENLABS = True
except ImportError:
    HAS_ELEVENLABS = False

try:
    from livekit.plugins import anthropic as lk_anthropic
    HAS_LK_ANTHROPIC = True
except ImportError:
    HAS_LK_ANTHROPIC = False


# ── Language maps ──────────────────────────────────────────────────────────────

_DEEPGRAM_LANGUAGE: Dict[str, str] = {"en": "en", "ms": "ms", "zh": "zh"}
_OPENAI_TTS_VOICE:  Dict[str, str] = {"en": "nova", "ms": "nova", "zh": "shimmer"}


def _cred(tenant, provider: str, key: str, fallback: Optional[str] = None) -> Optional[str]:
    """
    Pull a credential value from tenant.provider_credentials.
    Falls back to an optional default (e.g. a platform-wide fallback key for dev).
    """
    return (
        tenant.provider_credentials.get(provider, {}).get(key)
        or fallback
    )


# ── STT ────────────────────────────────────────────────────────────────────────

def create_stt(provider: str, language: str, tenant) -> Any:
    """Return a LiveKit STT plugin instance using the tenant's API key."""

    if provider == "deepgram":
        if not HAS_DEEPGRAM:
            raise ImportError("livekit-plugins-deepgram is not installed")
        api_key = _cred(tenant, "deepgram", "api_key")
        if not api_key:
            raise ValueError("Tenant has no Deepgram API key configured")
        return lk_deepgram.STT(
            api_key=api_key,
            model="nova-2",
            language=_DEEPGRAM_LANGUAGE.get(language, "en"),
        )

    if provider in ("openai", "whisper"):
        api_key = _cred(tenant, "openai", "api_key")
        if not api_key:
            raise ValueError("Tenant has no OpenAI API key configured")
        return lk_openai.STT(model="whisper-1", api_key=api_key)

    # Default → Deepgram if available
    if HAS_DEEPGRAM:
        return create_stt("deepgram", language, tenant)
    return create_stt("openai", language, tenant)


# ── LLM (LiveKit pipeline) ─────────────────────────────────────────────────────

def create_lk_llm(provider: str, model: str, tenant) -> Any:
    """Return a LiveKit LLM plugin instance using the tenant's API key."""

    if provider == "openai":
        api_key = _cred(tenant, "openai", "api_key")
        if not api_key:
            raise ValueError("Tenant has no OpenAI API key configured")
        return lk_openai.LLM(model=model or "gpt-4o", api_key=api_key)

    if provider == "groq":
        api_key = _cred(tenant, "groq", "api_key")
        if not api_key:
            raise ValueError("Tenant has no Groq API key configured")
        return lk_openai.LLM(
            model=model or "llama-3.1-70b-versatile",
            base_url="https://api.groq.com/openai/v1",
            api_key=api_key,
        )

    if provider == "anthropic":
        api_key = _cred(tenant, "anthropic", "api_key")
        if not api_key:
            raise ValueError("Tenant has no Anthropic API key configured")
        if HAS_LK_ANTHROPIC:
            return lk_anthropic.LLM(
                model=model or "claude-3-5-sonnet-20241022",
                api_key=api_key,
            )
        raise ImportError("livekit-plugins-anthropic is not installed")

    if provider in ("gemini", "google"):
        api_key = _cred(tenant, "google", "api_key")
        if not api_key:
            raise ValueError("Tenant has no Google API key configured")
        return lk_openai.LLM(
            model=model or "gemini-2.0-flash",
            base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
            api_key=api_key,
        )

    raise ValueError(f"Unknown LLM provider: '{provider}'")


# ── TTS ────────────────────────────────────────────────────────────────────────

def create_tts(provider: str, language: str, tenant) -> Any:
    """Return a LiveKit TTS plugin instance using the tenant's API key."""

    if provider == "cartesia":
        if not HAS_CARTESIA:
            raise ImportError("livekit-plugins-cartesia is not installed")
        api_key = _cred(tenant, "cartesia", "api_key")
        voice_id = _cred(tenant, "cartesia", f"voice_{language}") or _cred(tenant, "cartesia", "voice_id")
        if not api_key:
            raise ValueError("Tenant has no Cartesia API key configured")
        return lk_cartesia.TTS(api_key=api_key, voice=voice_id or "a0e99841-438c-4a64-b679-ae501e7d6091")

    if provider == "elevenlabs":
        if not HAS_ELEVENLABS:
            raise ImportError("livekit-plugins-elevenlabs is not installed")
        api_key = _cred(tenant, "elevenlabs", "api_key")
        voice_id = _cred(tenant, "elevenlabs", f"voice_{language}") or _cred(tenant, "elevenlabs", "voice_id")
        if not api_key:
            raise ValueError("Tenant has no ElevenLabs API key configured")
        return lk_elevenlabs.TTS(api_key=api_key, voice_id=voice_id or "21m00Tcm4TlvDq8ikWAM")

    if provider in ("openai", "openai-tts"):
        api_key = _cred(tenant, "openai", "api_key")
        if not api_key:
            raise ValueError("Tenant has no OpenAI API key configured")
        return lk_openai.TTS(voice=_OPENAI_TTS_VOICE.get(language, "nova"), api_key=api_key)

    raise ValueError(f"Unknown TTS provider: '{provider}'")


# ── VAD (platform-level, no API key needed) ────────────────────────────────────

def create_vad() -> Any:
    return silero.VAD.load()


# ── Convenience: load all three from tenant config ────────────────────────────

def load_tenant_providers(tenant, language: str = "en") -> Tuple[Any, Any, Any]:
    """
    Given a TenantConfig, return (stt, llm, tts) LiveKit plugin instances.
    All keys are read from tenant.provider_credentials.
    """
    stt_cfg = tenant.stt_config or {}
    llm_cfg = tenant.llm_config or {}
    tts_cfg = tenant.tts_config or {}

    stt_provider = stt_cfg.get(language) or stt_cfg.get("default", "deepgram")
    llm_provider = llm_cfg.get("provider", "openai")
    llm_model    = llm_cfg.get("model", "gpt-4o")
    tts_provider = tts_cfg.get(language) or tts_cfg.get("default", "cartesia")

    stt = create_stt(stt_provider, language, tenant)
    llm = create_lk_llm(llm_provider, llm_model, tenant)
    tts = create_tts(tts_provider, language, tenant)

    return stt, llm, tts


# ── Text-only LLM client (WhatsApp / non-voice) ───────────────────────────────

class LLMClient:
    """
    Async LLM wrapper for text-only API calls (WhatsApp, etc.).
    Uses the tenant's own API keys from provider_credentials.
    """

    def __init__(self, provider: str, model: str, tenant):
        self.provider = provider
        self.model    = model
        self._tenant  = tenant

    async def generate(
        self,
        messages: List[Dict[str, str]],
        tools: Optional[List[dict]] = None,
        stream: bool = False,
    ) -> Dict[str, Any]:
        if self.provider == "openai":
            return await self._call_openai(messages, tools)
        if self.provider == "groq":
            return await self._call_openai(
                messages, tools,
                base_url="https://api.groq.com/openai/v1",
                api_key=_cred(self._tenant, "groq", "api_key"),
            )
        if self.provider == "anthropic":
            return await self._call_anthropic(messages, tools)
        if self.provider in ("gemini", "google"):
            return await self._call_openai(
                messages, tools,
                base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
                api_key=_cred(self._tenant, "google", "api_key"),
            )
        return await self._call_openai(messages, tools)

    async def _call_openai(
        self,
        messages: List[Dict],
        tools: Optional[List[dict]],
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        from openai import AsyncOpenAI
        import json

        key = api_key or _cred(self._tenant, "openai", "api_key")
        if not key:
            raise ValueError("Tenant has no OpenAI API key configured")

        client = AsyncOpenAI(api_key=key, base_url=base_url)
        kwargs: Dict[str, Any] = {"model": self.model, "messages": messages}
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"

        response = await client.chat.completions.create(**kwargs)
        choice = response.choices[0].message

        tool_calls = None
        if choice.tool_calls:
            tool_calls = [
                {
                    "function": {
                        "name": tc.function.name,
                        "arguments": json.loads(tc.function.arguments),
                    }
                }
                for tc in choice.tool_calls
            ]

        return {"content": choice.content or "", "tool_calls": tool_calls}

    async def _call_anthropic(
        self,
        messages: List[Dict],
        tools: Optional[List[dict]],
    ) -> Dict[str, Any]:
        import anthropic

        key = _cred(self._tenant, "anthropic", "api_key")
        if not key:
            raise ValueError("Tenant has no Anthropic API key configured")

        client = anthropic.AsyncAnthropic(api_key=key)

        system = ""
        filtered = [m for m in messages if m["role"] != "system"]
        for m in messages:
            if m["role"] == "system":
                system = m["content"]

        kwargs: Dict[str, Any] = {
            "model": self.model,
            "max_tokens": 1024,
            "messages": filtered,
        }
        if system:
            kwargs["system"] = system
        if tools:
            kwargs["tools"] = [
                {
                    "name": t["function"]["name"],
                    "description": t["function"].get("description", ""),
                    "input_schema": t["function"].get("parameters", {}),
                }
                for t in tools
            ]

        response = await client.messages.create(**kwargs)

        content_text = ""
        tool_calls = None
        for block in response.content:
            if block.type == "text":
                content_text = block.text
            elif block.type == "tool_use":
                if tool_calls is None:
                    tool_calls = []
                tool_calls.append({
                    "function": {"name": block.name, "arguments": block.input}
                })

        return {"content": content_text, "tool_calls": tool_calls}


def load_llm_client(tenant) -> LLMClient:
    """Return a text-mode LLMClient configured from tenant settings."""
    provider = tenant.llm_config.get("provider", "openai")
    model    = tenant.llm_config.get("model", "gpt-4o")
    return LLMClient(provider=provider, model=model, tenant=tenant)
