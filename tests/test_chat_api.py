"""API-level test of the minimal chat slice with OpenRouter mocked out.

Covers: conversation create, SSE stream shape, user+assistant persistence,
and 404 on another tenant's conversation.
"""
import asyncio
import json

import jwt
import pytest
from httpx import ASGITransport, AsyncClient

from app import db, llm
from app.main import app


def token_for(user_id, org_id, role="owner"):
    return jwt.encode(
        {"sub": str(user_id), "org_id": str(org_id), "role": role},
        "dev-secret-change-me", algorithm="HS256",
    )


async def fake_stream_chat(model, messages, params):
    for chunk in ["Hello", " world"]:
        yield chunk


@pytest.fixture()
def client_env(fx, monkeypatch):
    monkeypatch.setattr(llm, "stream_chat", fake_stream_chat)
    return fx


def run(coro):
    return asyncio.run(coro)


def test_chat_roundtrip(client_env):
    fx = client_env

    async def flow():
        await db.init_pool()
        try:
            headers = {"Authorization": f"Bearer {token_for(fx.alice, fx.org_a)}"}
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as c:
                r = await c.post(
                    "/v1/conversations", json={"agent_id": str(fx.agent_a_private)},
                    headers=headers,
                )
                assert r.status_code == 201, r.text
                conv_id = r.json()["id"]

                r = await c.post(
                    f"/v1/conversations/{conv_id}/chat", json={"message": "hi"},
                    headers=headers,
                )
                assert r.status_code == 200
                events = [
                    json.loads(line[6:])
                    for line in r.text.splitlines() if line.startswith("data: ")
                ]
                assert [e for e in events if e["type"] == "delta"]
                assert events[-1]["type"] == "done"
                full = "".join(e["text"] for e in events if e["type"] == "delta")
                assert full == "Hello world"

                r = await c.get(f"/v1/conversations/{conv_id}/messages", headers=headers)
                msgs = r.json()["messages"]
                assert [m["role"] for m in msgs] == ["user", "assistant"]
                assert msgs[1]["content"] == [{"type": "text", "text": "Hello world"}]

                # Bob (org B) must not see or chat in Alice's conversation.
                bob_headers = {"Authorization": f"Bearer {token_for(fx.bob, fx.org_b)}"}
                r = await c.get(
                    f"/v1/conversations/{conv_id}/messages", headers=bob_headers
                )
                assert r.status_code == 404
                r = await c.post(
                    f"/v1/conversations/{conv_id}/chat", json={"message": "hi"},
                    headers=bob_headers,
                )
                assert r.status_code == 404
        finally:
            await db.close_pool()

    run(flow())


def test_chat_error_when_key_missing(fx):
    # Without monkeypatching, stream_chat fails fast (no key configured):
    # the endpoint must surface an SSE error event, not a 500.
    async def flow():
        await db.init_pool()
        try:
            headers = {"Authorization": f"Bearer {token_for(fx.alice, fx.org_a)}"}
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as c:
                r = await c.post(
                    "/v1/conversations", json={"agent_id": str(fx.agent_a_private)},
                    headers=headers,
                )
                conv_id = r.json()["id"]
                r = await c.post(
                    f"/v1/conversations/{conv_id}/chat", json={"message": "hi"},
                    headers=headers,
                )
                assert r.status_code == 200
                events = [
                    json.loads(line[6:])
                    for line in r.text.splitlines() if line.startswith("data: ")
                ]
                assert events[-1]["type"] == "error"
                assert "API key" in events[-1]["detail"]
        finally:
            await db.close_pool()

    run(flow())
