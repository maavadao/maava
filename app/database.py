import asyncpg
import logging
from app.config import settings

logger = logging.getLogger(__name__)

_pool: asyncpg.Pool = None


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        if not settings.database_url:
            raise RuntimeError(
                "DATABASE_URL is not set. "
                "Configure it as an env var or Cloud Run secret."
            )
        _pool = await asyncpg.create_pool(
            settings.database_url,
            # statement_cache_size=0 is required for Supabase transaction-mode pooler (pgBouncer)
            statement_cache_size=0,
            min_size=1,
            max_size=10,
            ssl="require",
        )
        logger.info("Database connection pool created")
    return _pool


async def init_db():
    """Create tables if they don't exist. Called on startup."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS skills (
                id           TEXT PRIMARY KEY,
                skill_id     TEXT NOT NULL,
                name         TEXT NOT NULL,
                description  TEXT,
                category     TEXT NOT NULL DEFAULT '',
                installs     INTEGER NOT NULL DEFAULT 0,
                source       TEXT NOT NULL,
                source_url   TEXT,
                is_installed BOOLEAN NOT NULL DEFAULT false,
                created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_skills_name
                ON skills (name);
            CREATE INDEX IF NOT EXISTS idx_skills_source
                ON skills (source);
            CREATE INDEX IF NOT EXISTS idx_skills_category
                ON skills (category);
            CREATE INDEX IF NOT EXISTS idx_skills_installs
                ON skills (installs DESC);

            CREATE TABLE IF NOT EXISTS scrape_jobs (
                id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                status          TEXT DEFAULT 'pending'
                                    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
                skills_found    INTEGER DEFAULT 0,
                error_message   TEXT,
                started_at      TIMESTAMPTZ DEFAULT NOW(),
                completed_at    TIMESTAMPTZ
            );

            CREATE INDEX IF NOT EXISTS idx_scrape_jobs_status
                ON scrape_jobs (status);
            CREATE INDEX IF NOT EXISTS idx_scrape_jobs_started
                ON scrape_jobs (started_at DESC);
            """
        )
    logger.info("Database initialized")


async def close_db():
    global _pool
    if _pool:
        await _pool.close()
        _pool = None
        logger.info("Database pool closed")
