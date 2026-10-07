import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import TenantContext, require_org
from ..db import tenant_txn
from ..ids import uuid7

router = APIRouter(tags=["agents"])


class AgentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    system_prompt: str = ""
    model: str  # OpenRouter model id
    params: dict = Field(default_factory=dict)
    visibility: str = Field(default="private", pattern="^(private|org)$")


@router.get("/agents")
async def list_agents(ctx: TenantContext = Depends(require_org)):
    async with tenant_txn(ctx.org_id, ctx.user_id) as conn:
        rows = await conn.fetch(
            """SELECT id, name, description, model, visibility, owner_id, updated_at
               FROM agents ORDER BY updated_at DESC"""
        )
    return {"agents": [dict(r) for r in rows]}


@router.post("/agents", status_code=201)
async def create_agent(body: AgentCreate, ctx: TenantContext = Depends(require_org)):
    agent_id = uuid7()
    async with tenant_txn(ctx.org_id, ctx.user_id) as conn:
        # RLS WITH CHECK enforces org_id/owner_id even if this code regresses.
        await conn.execute(
            """INSERT INTO agents (id, org_id, owner_id, name, description, system_prompt,
                                   model, params, visibility)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)""",
            agent_id, ctx.org_id, ctx.user_id, body.name, body.description,
            body.system_prompt, body.model, json.dumps(body.params), body.visibility,
        )
        await conn.execute(
            """INSERT INTO audit_events (id, org_id, actor_id, action, resource_type, resource_id)
               VALUES ($1, $2, $3, 'agent.create', 'agent', $4)""",
            uuid7(), ctx.org_id, ctx.user_id, agent_id,
        )
    return {"id": agent_id}


@router.get("/agents/{agent_id}")
async def get_agent(agent_id: str, ctx: TenantContext = Depends(require_org)):
    async with tenant_txn(ctx.org_id, ctx.user_id) as conn:
        row = await conn.fetchrow(
            """SELECT id, name, description, system_prompt, model, params, visibility,
                      owner_id, created_at, updated_at
               FROM agents WHERE id = $1::uuid""",
            agent_id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="agent not found")
    return dict(row)
