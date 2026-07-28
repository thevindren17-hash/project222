"""
Provider Factory — Dynamic LLM loading based on tenant config.

All API keys come from the tenant's provider_credentials stored in Supabase.
Clinics add their own keys in the dashboard — zero platform-level AI keys needed.

Text pipeline (WhatsApp):  load_llm_client(tenant) → LLMClient.generate()
"""

import asyncio
import json
import random
import re
import logging
from typing import Any, Awaitable, Callable, Optional, List, Dict

_logger = logging.getLogger(__name__)

# Errors that are worth retrying — transient, not the caller's fault
_RETRIABLE = ("rate limit", "ratelimit", "429", "503", "502", "timeout",
              "overloaded", "connection", "server error")

# Splits after ., !, ? (incl. fullwidth Chinese punctuation) regardless of
# whether whitespace follows -- a degenerate model reply commonly glues
# consecutive questions together with no space at all ("Nama anda?Nombor
# telefon?"), and splitting only on "punctuation + space" would leave those
# glued repeats undetected as duplicates of the same question asked earlier
# WITH a leading space.
_SENTENCE_SPLIT_RE = re.compile(r'(?<=[.!?。！？])\s*')


def _cap_to_first_question(text: str) -> str:
    """
    Second guard against the same gpt-oss degeneration _collapse_repeated_sentences
    only partially covers: instead of repeating one question verbatim (which the
    dedup above catches), the model sometimes asks the SAME question several
    differently-worded ways in one reply -- confirmed live: "What other time on
    July 29 would work for you?", "Which time would you prefer on July 29?",
    "Please let me know a preferred time on July 29..." all landing in one message,
    none of them exact-duplicate text so the dedup let every one through. Every
    system prompt in this codebase already mandates exactly one question per turn
    -- rather than trust the model to keep obeying that under a tool-heavy,
    reasoning-model conversation, enforce it as a hard cut: once a second '?'
    shows up, drop everything from there on, same philosophy as the max_tokens
    backstop below (a hard ceiling, not just a lower suggestion).
    """
    if not text:
        return text
    first = text.find("?")
    if first == -1:
        return text
    second = text.find("?", first + 1)
    if second == -1:
        return text
    return text[: first + 1]


def _collapse_repeated_sentences(text: str) -> str:
    """
    Defensive guard against decoding-repetition loops: a model (observed on
    Groq's gpt-oss family under tool-heavy conversations) re-asking the same
    question, or repeating an entire confirmation sentence, verbatim several
    times within one reply instead of once. This doesn't stop the model from
    degenerating, but it guarantees the patient never sees the same sentence
    twice -- at worst they see each distinct (mis)phrasing once instead of a
    multi-paragraph wall of exact repeats.
    """
    if not text:
        return text
    seen: set[str] = set()
    out: List[str] = []
    for part in _SENTENCE_SPLIT_RE.split(text.strip()):
        key = part.strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(part.strip())
    return " ".join(out)


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
                # Confirmed live (escalations table): Groq's 429s come in two
                # shapes that need completely different handling. A per-
                # MINUTE (TPM) quota genuinely resets within the Retry-After
                # window (seconds), so waiting that long and retrying can
                # actually succeed. A per-DAY (TPD) quota -- hit here after a
                # full day of testing exhausted the free tier's 200,000
                # tokens/day -- reports Retry-After in MINUTES (seen: "try
                # again in 15m"), which no request should ever block on. The
                # old fixed 30s cap made this worse, not better: it waited
                # just long enough to burn all 3 retries pointlessly before
                # failing anyway, instead of failing fast. Detect the daily
                # case from Groq's own error text and don't retry it at all
                # -- no wait inside a single request can make a 15-minute
                # quota reset happen sooner.
                if "tokens per day" in err_str or "(tpd)" in err_str:
                    raise
                # Rate-limit errors carry the provider's own authoritative
                # wait time in a Retry-After header -- use it when available;
                # only guess with the short backoff for genuinely transient
                # errors (timeouts, connection blips) where a quick retry is
                # actually appropriate.
                retry_after = getattr(getattr(exc, "response", None), "headers", {}).get("retry-after")
                wait: float
                if retry_after:
                    try:
                        wait = min(float(retry_after), 30.0) + random.uniform(0, 1)
                    except ValueError:
                        wait = (2 ** attempt) + random.uniform(0, 1)
                else:
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
        if self.provider == "kimi":
            return await self._call_openai(
                messages, tools,
                base_url="https://api.moonshot.ai/v1",
                api_key=_cred(self._tenant, "kimi", "api_key"),
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
        # Both settings are configurable per-tenant in the dashboard (Model
        # Settings tab) but were never actually read here — every call ran
        # completely unbounded, so a model that failed to stop generating
        # (e.g. a repetition loop) kept going until the *provider's* own
        # ceiling kicked in instead of the tenant's configured limit.
        llm_config = getattr(self._tenant, "llm_config", None) or {}
        # 1024 was generous enough that a model degenerating into a repeat/
        # rephrase loop (observed live: Groq's gpt-oss family asking the same
        # "what time works" question 6+ different ways in one reply, or
        # narrating a fake booking confirmation without ever calling the
        # tool) could ramble for hundreds of tokens before hitting any
        # ceiling at all -- frequency/presence_penalty only discourage exact
        # token repeats, not a differently-worded restatement of the same
        # question, so they didn't catch this pattern on their own.
        # _collapse_repeated_sentences() and _cap_to_first_question() below
        # are the real defense against that now (they catch it directly,
        # including the differently-worded case); this cap only needs to
        # stop a bug in those two from rambling unbounded, so 300 -- a bit
        # more headroom than the original 200 for a genuinely longer reply
        # -- is fine.
        # Kimi's K-series models (k2.6, k3 -- the only ones offered in the
        # dashboard) use a different request schema than the older
        # moonshot-v1 family: max_tokens is deprecated in favor of
        # max_completion_tokens, and temperature/frequency_penalty/
        # presence_penalty aren't accepted on K-series requests at all.
        # Sending them risks the exact "unknown field -> hard 400 on every
        # single call" failure already hit once with Gemini -- so K-series
        # gets its own token-limit key and skips the sampling params below
        # entirely, rather than gambling on ambiguous docs about whether
        # they're silently ignored.
        is_kimi = self.provider == "kimi"
        kwargs: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
        }
        token_limit = llm_config.get("max_tokens") or 300
        if is_kimi:
            kwargs["max_completion_tokens"] = token_limit
            # Hints to Kimi that requests carrying this key share a common
            # prefix (this tenant's system prompt) worth reusing between
            # calls -- without it there's nothing telling their cache to
            # even attempt matching this tenant's requests against each
            # other. Scoped per-tenant, not per-conversation: the whole
            # point is that every conversation for this clinic shares the
            # same clinic-info/instructions prefix, so they should all be
            # eligible to hit the same cache entry.
            tenant_id = getattr(self._tenant, "tenant_id", None)
            if tenant_id:
                kwargs["prompt_cache_key"] = f"tenant-{tenant_id}"
        else:
            kwargs["max_tokens"] = token_limit
        if llm_config.get("temperature") is not None and not is_kimi:
            kwargs["temperature"] = llm_config["temperature"]
        # Some models (esp. Groq's gpt-oss family) fall into degenerate
        # repetition loops under tool-heavy conversations -- re-asking the
        # same question several differently-phrased ways in one reply
        # instead of the single question the system prompt asks for. A
        # modest repetition penalty makes the sampler less likely to repeat
        # tokens it already used, without materially changing normal replies.
        # NOT sent to Gemini: its OpenAI-compatible endpoint rejects both
        # fields outright on 2.5+ models with a hard 400 INVALID_ARGUMENT
        # ("Unknown name 'frequency_penalty': Cannot find field") -- this
        # was breaking every single call for a tenant on Gemini, not just
        # this one feature, until caught live.
        if self.provider not in ("gemini", "google") and not is_kimi:
            kwargs["frequency_penalty"] = llm_config.get("frequency_penalty", 0.4)
            kwargs["presence_penalty"] = llm_config.get("presence_penalty", 0.2)
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"
        # gpt-oss on Groq is a reasoning model that defaults to "medium"
        # reasoning_effort -- it silently spends several extra seconds
        # "thinking" before every reply, tool call or not, which is most of
        # where WhatsApp's multi-second-to-30s response times were coming
        # from. A receptionist's turns (confirm a name, ask for a date) don't
        # need deep reasoning, so default to "low" for latency; still
        # per-tenant overridable via llm_config for a clinic that wants more
        # deliberate FAQ answers.
        #
        # Deliberately NOT setting include_reasoning=False here anymore.
        # That was originally added to keep the model's internal reasoning
        # trace out of the visible reply -- but Groq's own community forum
        # documents the opposite effect for this exact setting: gibberish/
        # leaked-reasoning content appearing IN the visible reply, worse in
        # longer, tool-heavy conversations (community.groq.com/t/670) --
        # exactly the pattern reported live here (a multi-question rambling
        # reply containing unfilled "[date]"/"[time]" placeholders, mid-turn,
        # after several check_slots-involving turns). By default (this field
        # simply unset) gpt-oss already returns reasoning in its own
        # separate `reasoning` field rather than mixed into `content` -- the
        # explicit override was solving a smaller problem by causing a
        # bigger one.
        if self.provider == "groq" and "gpt-oss" in self.model:
            kwargs["reasoning_effort"] = llm_config.get("reasoning_effort", "low")
        elif self.provider in ("gemini", "google") and "flash" in self.model and "lite" not in self.model:
            # Same latency trap, different provider: Gemini's non-Lite Flash
            # tier (2.5/3.x) defaults to a dynamic "thinking" budget that's
            # on by default -- Flash-Lite already defaults it off (left
            # alone here), and Pro is deliberately chosen for deep reasoning
            # so it's left alone too. reasoning_effort is natively supported
            # through Gemini's OpenAI-compatible endpoint.
            kwargs["reasoning_effort"] = llm_config.get("reasoning_effort", "low")

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

        content = _cap_to_first_question(_collapse_repeated_sentences(choice.content or ""))
        return {"content": content, "tool_calls": tool_calls}

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

        llm_config = getattr(self._tenant, "llm_config", None) or {}
        kwargs: Dict[str, Any] = {
            "model": self.model,
            "max_tokens": llm_config.get("max_tokens") or 1024,
            "messages": _to_anthropic_messages(messages),
        }
        if llm_config.get("temperature") is not None:
            kwargs["temperature"] = llm_config["temperature"]
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

        content_text = _cap_to_first_question(_collapse_repeated_sentences(content_text))
        return {"content": content_text, "tool_calls": tool_calls}


def load_llm_client(tenant) -> LLMClient:
    """Return a text-mode LLMClient configured from tenant settings."""
    provider = tenant.llm_config.get("provider", "groq")
    model    = tenant.llm_config.get("model", "openai/gpt-oss-120b")
    return LLMClient(provider=provider, model=model, tenant=tenant)
