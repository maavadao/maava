"""Conversations + SSE chat loop (PLAN §7, minimal slice: no tools yet).

The user message is persisted before the LLM call; the assistant message is
persisted on stream completion, or as a partial (marked truncated) if the
client disconnects mid-stream. The DB transaction is never held open while
streaming from OpenRouter.
"""
import json
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import llm
from ..auth import TenantContext, require_org
from ..db import tenant_txn
from ..ids import uuid7

router = APIRouter(tags=["conversations"])


class ConversationCreate(BaseModel):
    agent_id: UUID


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=32_000)


@router.post("/conversations", status_code=201)
async def create_conversation(body: ConversationCreate, ctx: TenantContext = Depends(require_org)):
    conv_id = uuid7()
    async with tenant_txn(ctx.org_id, ctx.user_id) as conn:
        agent = await conn.fetchrow("SELECT id FROM agents WHERE id = $1", body.agent_id)
        if agent is None:
            raise HTTPException(status_code=404, detail="agent not found")
        await conn.execute(
            """INSERT INTO conversations (id, org_id, user_id, agent_id)
               VALUES ($1, $2, $3, $4)""",
            conv_id, ctx.org_id, ctx.user_id, body.agent_id,
        )
    return {"id": conv_id}


@router.get("/conversations")
async def list_conversations(ctx: TenantContext = Depends(require_org)):
    async with tenant_txn(ctx.org_id, ctx.user_id) as conn:
        rows = await conn.fetch(
            """SELECT c.id, c.agent_id, c.title, c.updated_at, a.name AS agent_name
               FROM conversations c JOIN agents a ON a.id = c.agent_id
               ORDER BY c.updated_at DESC"""
        )
    return {"conversations": [dict(r) for r in rows]}


@router.get("/conversations/{conversation_id}/messages")
async def list_messages(conversation_id: UUID, ctx: TenantContext = Depends(require_org)):
    async with tenant_txn(ctx.org_id, ctx.user_id) as conn:
        conv = await conn.fetchrow(
            "SELECT id FROM conversations WHERE id = $1", conversation_id
        )
        if conv is None:
            raise HTTPException(status_code=404, detail="conversation not found")
        rows = await conn.fetch(
            """SELECT id, seq, role, content, model, created_at
               FROM messages WHERE conversation_id = $1 ORDER BY seq""",
            conversation_id,
        )
    return {
        "messages": [dict(r) | {"content": json.loads(r["content"])} for r in rows]
    }


def _blocks_to_text(content: list[dict]) -> str:
    return "".join(b.get("text", "") for b in content if b.get("type") == "text")


async def _insert_message(
    conn, conversation_id: UUID, org_id: UUID, role: str, text: str,
    model: str | None = None, token_usage: dict | None = None,
) -> None:
    await conn.execute(
        """INSERT INTO messages (id, conversation_id, org_id, seq, role, content, model,
                                 token_usage)
           VALUES ($1, $2, $3,
                   (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = $2),
                   $4, $5::jsonb, $6, $7::jsonb)""",
        uuid7(), conversation_id, org_id, role,
        json.dumps([{"type": "text", "text": text}]), model,
        json.dumps(token_usage) if token_usage is not None else None,
    )


@router.post("/conversations/{conversation_id}/chat")
async def chat(
    conversation_id: UUID, body: ChatIn, ctx: TenantContext = Depends(require_org)
):
    # Txn 1: load agent + history, persist the user message. Then release the
    # connection before streaming.
    async with tenant_txn(ctx.org_id, ctx.user_id) as conn:
        agent = await conn.fetchrow(
            """SELECT a.system_prompt, a.model, a.params
               FROM conversations c JOIN agents a ON a.id = c.agent_id
               WHERE c.id = $1""",
            conversation_id,
        )
        if agent is None:
            raise HTTPException(status_code=404, detail="conversation not found")
        history = await conn.fetch(
            """SELECT role, content FROM messages
               WHERE conversation_id = $1 AND role IN ('user', 'assistant') ORDER BY seq""",
            conversation_id,
        )
        await _insert_message(conn, conversation_id, ctx.org_id, "user", body.message)
        await conn.execute(
            "UPDATE conversations SET updated_at = now() WHERE id = $1", conversation_id
        )

    llm_messages = []
    if agent["system_prompt"]:
        llm_messages.append({"role": "system", "content": agent["system_prompt"]})
    for m in history:
        llm_messages.append(
            {"role": m["role"], "content": _blocks_to_text(json.loads(m["content"]))}
        )
    llm_messages.append({"role": "user", "content": body.message})

    async def persist_assistant(text: str, truncated: bool) -> None:
        async with tenant_txn(ctx.org_id, ctx.user_id) as conn:
            await _insert_message(
                conn, conversation_id, ctx.org_id, "assistant", text,
                model=agent["model"],
                token_usage={"truncated": True} if truncated else None,
            )

    async def event_stream():
        acc: list[str] = []
        done = False
        try:
            async for delta in llm.stream_chat(
                agent["model"], llm_messages, json.loads(agent["params"])
            ):
                acc.append(delta)
                yield f"data: {json.dumps({'type': 'delta', 'text': delta})}\n\n"
            done = True
            await persist_assistant("".join(acc), truncated=False)
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except llm.LLMError as err:
            done = True
            yield f"data: {json.dumps({'type': 'error', 'detail': str(err)})}\n\n"
        finally:
            if not done and acc:  # client disconnected mid-stream
                await persist_assistant("".join(acc), truncated=True)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
