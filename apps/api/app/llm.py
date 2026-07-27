"""Thin OpenRouter streaming client (PLAN §9): no gateway of our own.

stream_chat() yields assistant text deltas. Callers must not hold a DB
transaction while iterating — streams can run for minutes.
"""
import json
from collections.abc import AsyncIterator

import httpx

from .config import get_settings


class LLMError(RuntimeError):
    pass


async def stream_chat(model: str, messages: list[dict], params: dict) -> AsyncIterator[str]:
    """Stream completion deltas from OpenRouter for OpenAI-format `messages`."""
    s = get_settings()
    if not s.openrouter_api_key:
        raise LLMError("OpenRouter API key not configured (set AP_OPENROUTER_API_KEY)")
    payload = {"model": model, "messages": messages, "stream": True, **params}
    async with httpx.AsyncClient(timeout=httpx.Timeout(10, read=300)) as client:
        async with client.stream(
            "POST",
            f"{s.openrouter_base_url}/chat/completions",
            headers={"Authorization": f"Bearer {s.openrouter_api_key}"},
            json=payload,
        ) as resp:
            if resp.status_code != 200:
                body = (await resp.aread()).decode(errors="replace")[:500]
                raise LLMError(f"OpenRouter returned {resp.status_code}: {body}")
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data = line[6:]
                if data == "[DONE]":
                    return
                delta = (
                    json.loads(data).get("choices", [{}])[0].get("delta", {}).get("content")
                )
                if delta:
                    yield delta
