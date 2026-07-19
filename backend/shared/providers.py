"""
Provider Factory — Dynamic LLM loading based on tenant config.

All API keys come from the tenant's provider_credentials stored in Supabase.
Clinics add their own keys in the dashboard — zero platform-level AI keys needed.

Text pipeline (WhatsApp):  load_llm_client(tenant) → LLMClient.generate()
"""

import asyncio
import random
import logging
from typing import Any, Optional, List, Dict

_logger = logging.getLogger(__name__)

# Errors that are worth retrying — transient, not the caller's fault
_RETRIABLE = ("rate limit", "ratelimit", "429", "503", "502", "timeout",
              "overloaded", "connection", "server error")


def _cred(tenant, provider: str, key: str, fallback: Optional[str] = None) -> Optional[str]:
    """
    Pull a credential value from tenant.provider_credentials.
    Falls back to an optional default (e.g. a platform-wide fallback key for dev).
    """
    return (
        tenant.provider_credentials.get(provider, {}).get(key)
        or fallback
    )


# ── Text-only LLM client (WhatsApp) ────────────────────────────────────────────

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
        max_retries: int = 3,
    ) -> Dict[str, Any]:
        last_exc: Optional[Exception] = None
        for attempt in range(max_retries):
            try:
                return await self._dispatch(messages, tools)
            except Exception as exc:
                err_str = str(exc).lower()
                is_retriable = any(k in err_str for k in _RETRIABLE)
                if not is_retriable or attempt == max_retries - 1:
                    raise
                wait = (2 ** attempt) + random.uniform(0, 1)
                _logger.warning(
                    f"LLM {self.provider} transient error (attempt {attempt + 1}/{max_retries}), "
                    f"retrying in {wait:.1f}s: {exc}"
                )
                last_exc = exc
                await asyncio.sleep(wait)
        raise last_exc  # type: ignore[misc]

    async def _dispatch(
        self,
        messages: List[Dict[str, str]],
        tools: Optional[List[dict]],
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
        if self.provider == "mistral":
            return await self._call_openai(
                messages, tools,
                base_url="https://api.mistral.ai/v1",
                api_key=_cred(self._tenant, "mistral", "api_key"),
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
