"""
Agent Test Endpoint
Lets the dashboard owner chat with the AI agent using their live config
without touching any production data.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from shared.tenant_config import get_tenant_by_id
from shared.providers import load_llm_client
from shared.tools import TOOL_DEFINITIONS, get_faq
from shared.utils import logger

router = APIRouter()


class TestMessage(BaseModel):
    tenant_id: str
    message: str
    history: list = []   # [{"role": "user"|"assistant", "content": "..."}]


@router.post("/test")
async def test_agent(req: TestMessage):
    tenant = await get_tenant_by_id(req.tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    if not tenant.system_prompt:
        raise HTTPException(status_code=400, detail="No system prompt configured. Set one in Agent Config first.")

    llm_client = load_llm_client(tenant)

    conversation = list(req.history) + [{"role": "user", "content": req.message}]

    messages_payload = [
        {
            "role": "system",
            "content": tenant.system_prompt
                + "\n\n[TEST MODE — behave exactly as in production. Tools are active.]",
        },
        *conversation,
    ]

    enabled_tools = [
        t for t in TOOL_DEFINITIONS
        if tenant.tool_config.get(t["function"]["name"], True)
    ]

    try:
        response = await llm_client.generate(
            messages=messages_payload,
            tools=enabled_tools or None,
        )
    except Exception as e:
        logger.error(f"Agent test LLM error: {e}")
        raise HTTPException(status_code=502, detail=f"LLM error: {str(e)}")

    reply = response.get("content", "")
    tool_calls = response.get("tool_calls", [])
    tool_results = []

    # Execute tools so the tester can see real results
    for tc in tool_calls:
        fn = tc["function"]["name"]
        args = tc["function"]["arguments"]
        result_text = ""

        if fn == "get_faq":
            res = await get_faq(tenant, args.get("question", ""))
            result_text = res.get("answer", "No answer found") if res["success"] else "No answer found"
        else:
            result_text = f"[Tool '{fn}' would run in production — skipped in test mode]"

        tool_results.append({"tool": fn, "args": args, "result": result_text})
        if not reply:
            reply = result_text

    if not reply:
        reply = "I'm sorry, I couldn't process that. Please check your LLM configuration."

    updated_history = conversation + [{"role": "assistant", "content": reply}]

    return {
        "reply": reply,
        "tool_calls": tool_results,
        "history": updated_history,
        "provider": tenant.llm_config.get("provider", "unknown"),
        "model": tenant.llm_config.get("model", ""),
    }
