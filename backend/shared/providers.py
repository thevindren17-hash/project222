"""
Provider Factory — Dynamic LLM loading based on tenant config.

All API keys come from the tenant's provider_credentials stored in Supabase.
Clinics add their own keys in the dashboard — zero platform-level AI keys needed.

Text pipeline (WhatsApp):  load_llm_client(tenant) → LLMClient.generate()
"""

import asyncio
import json
import random
import logging
from typing import Any, Awaitable, Callable, Optional, List, Dict

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


def _to_anthropic_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Translate the OpenAI-style message list used everywhere in this codebase
    (plain {role, content}, plus assistant messages carrying a "tool_calls"
    list and "tool" role messages produced by LLMClient.run_with_tools) into
    Anthropic's block format. Anthropic requires all tool_result blocks that
    answer a given assistant turn's tool_use calls to be coalesced into a
    single following user turn, matched by id — run_with_tools always appends
    "tool" messages immediately after the assistant tool-call message and
    before the next real turn, so buffering consecutive ones here is safe.
    """
    out: List[Dict[str, Any]] = []
    pending_tool_results: List[Dict[str, Any]] = []

    def _flush():
        if pending_tool_results:
            out.append({"role": "user", "content": list(pending_tool_results)})
            pending_tool_results.clear()

    for m in messages:
        role = m["role"]
        if role == "system":
            continue
        if role == "tool":
            pending_tool_results.append({
                "type": "tool_result",
                "tool_use_id": m["tool_call_id"],
                "content": m["content"],
            })
            continue

        _flush()

        if role == "assistant" and m.get("tool_calls"):
            blocks: List[Dict[str, Any]] = []
            if m.get("content"):
                blocks.append({"type": "text", "text": m["content"]})
            for tc in m["tool_calls"]:
                raw_args = tc["function"]["arguments"]
                blocks.append({
                    "type": "tool_use",
                    "id": tc["id"],
                    "name": tc["function"]["name"],
                    "input": json.loads(raw_args) if isinstance(raw_args, str) else raw_args,
                })
            out.append({"role": "assistant", "content": blocks})
        else:
            out.append({"role": role, "content": m["content"]})

    _flush()
    return out


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

    async def run_with_tools(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[dict]],
        execute_tool: Callable[[str, dict], Awaitable[str]],
        max_steps: int = 4,
        parse_embedded_tool_calls: Optional[Callable[[str], tuple]] = None,
    ) -> Dict[str, Any]:
        """
        Runs the tool-calling loop to completion instead of a single shot:
        call the LLM, execute any tool calls, feed the *results* back to the
        LLM so it can react to them (ask the next question, confirm, etc.),
        and repeat until it produces a final reply with no more tool calls.

        Without this, a tool's raw return string ends up being used as the
        bot's entire reply and the model never gets to respond to its own
        tool call — which is what caused agents to loop, replaying the same
        tool output verbatim instead of moving the conversation forward.

        Works for any tenant system prompt / any provider: `messages` is the
        plain OpenAI-style {role, content} list already used throughout this
        codebase, and the caller's own copy is never mutated — history stored
        by the caller stays plain text, only this method's local copy grows
        provider-shaped tool_call/tool turns for the duration of the request.

        `parse_embedded_tool_calls`: optional hook for models (e.g. some
        Groq/Llama models) that emit "<function=...>" tags in plain text
        instead of using structured tool calling — given the reply content,
        returns (cleaned_content, tool_calls) or (content, []) if none found.
        """
        local_messages = list(messages)
        tool_log: List[Dict[str, Any]] = []
        content = ""

        for _ in range(max_steps):
            response = await self.generate(messages=local_messages, tools=tools)
            content = response.get("content", "")
            tool_calls = response.get("tool_calls")

            if not tool_calls and parse_embedded_tool_calls and content:
                content, tool_calls = parse_embedded_tool_calls(content)

            if not tool_calls:
                return {"content": content, "tool_calls": tool_log}

            assistant_tool_calls = []
            call_results = []
            for tc in tool_calls:
                name = tc["function"]["name"]
                args = tc["function"]["arguments"]
                call_id = tc.get("id") or f"call_{len(tool_log)}"
                try:
                    result_text = await execute_tool(name, args)
                except Exception as exc:
                    result_text = f"Tool error: {exc}"

                tool_log.append({"tool": name, "args": args, "result": result_text})
                assistant_tool_calls.append({
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": json.dumps(args)},
                })
                call_results.append((call_id, result_text))

            local_messages.append({
                "role": "assistant",
                "content": content or None,
                "tool_calls": assistant_tool_calls,
            })
            for call_id, result_text in call_results:
                local_messages.append({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": result_text,
                })

        # Ran out of steps without a final text reply — degrade gracefully
        # (e.g. a model stuck re-calling the same tool) rather than erroring.
        fallback = tool_log[-1]["result"] if tool_log else ""
        return {"content": content or fallback, "tool_calls": tool_log}

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
                    "id": tc.id,
                    "function": {
                        "name": tc.function.name,
                        "arguments": json.loads(tc.function.arguments),
                    },
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
        for m in messages:
            if m["role"] == "system":
                system = m["content"]

        kwargs: Dict[str, Any] = {
            "model": self.model,
            "max_tokens": 1024,
            "messages": _to_anthropic_messages(messages),
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
                    "id": block.id,
                    "function": {"name": block.name, "arguments": block.input},
                })

        return {"content": content_text, "tool_calls": tool_calls}


def load_llm_client(tenant) -> LLMClient:
    """Return a text-mode LLMClient configured from tenant settings."""
    provider = tenant.llm_config.get("provider", "groq")
    model    = tenant.llm_config.get("model", "openai/gpt-oss-120b")
    return LLMClient(provider=provider, model=model, tenant=tenant)
