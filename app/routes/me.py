from fastapi import APIRouter, Depends

from ..auth import TenantContext, get_tenant
from ..db import tenant_txn

router = APIRouter(tags=["me"])


@router.get("/me")
async def get_me(ctx: TenantContext = Depends(get_tenant)):
    async with tenant_txn(ctx.org_id, ctx.user_id) as conn:
        user = await conn.fetchrow("SELECT id, email, name FROM users WHERE id = $1", ctx.user_id)
        orgs = await conn.fetch(
            """SELECT o.id, o.name, m.role FROM memberships m
               JOIN orgs o ON o.id = m.org_id WHERE m.user_id = $1""",
            ctx.user_id,
        )
    return {
        "user": dict(user) if user else None,
        "active_org_id": ctx.org_id,
        "orgs": [dict(o) for o in orgs],
    }
