"""Database access. THE tenancy rule lives here:

Every query runs inside an explicit transaction that sets tenant context with
set_config(..., is_local => true) — the parameterized equivalent of SET LOCAL.
With transaction pooling the underlying session is shared across tenants, so
plain SET or autocommit queries would leak context. There is deliberately no
API on this module for running a query outside tenant_txn().
"""
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from uuid import UUID

import asyncpg

from .config import get_settings

_pool: asyncpg.Pool | None = None


async def init_pool() -> None:
    global _pool
    s = get_settings()
    _pool = await asyncpg.create_pool(
        dsn=s.database_url, min_size=s.db_pool_min, max_size=s.db_pool_max
    )


async def close_pool() -> None:
    if _pool is not None:
        await _pool.close()


@asynccontextmanager
async def tenant_txn(org_id: UUID | None, user_id: UUID) -> AsyncIterator[asyncpg.Connection]:
    """Yield a connection inside a transaction with tenant context applied.

    org_id may be None only during signup bootstrap (user has no org yet);
    RLS then denies every org-scoped row.
    """
    assert _pool is not None, "init_pool() not called"
    async with _pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)",
                str(org_id) if org_id else "",
                str(user_id),
            )
            yield conn
