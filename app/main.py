import asyncio
import hmac
import logging
from contextlib import asynccontextmanager
from typing import Optional, Set

from fastapi import Depends, FastAPI, HTTPException, Query, Security
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security.api_key import APIKeyHeader

from app.config import settings
from app.database import close_db, get_pool, init_db
from app.models import ScrapeJobResponse, SkillItem, SkillsListResponse
from app.scraper import run_awesome_scrape_job, run_scrape_job

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)

# ── Background task registry (outlives request lifecycle on Cloud Run) ─────────
_running_tasks: Set[asyncio.Task] = set()
_scheduler_task: Optional[asyncio.Task] = None


# ── API-key auth dependency ────────────────────────────────────────────────────
_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


async def require_api_key(api_key: Optional[str] = Security(_api_key_header)) -> None:
    """No-op when API_KEY env var is not set. Enforces key when it is set."""
    if settings.api_key and (not api_key or not hmac.compare_digest(api_key, settings.api_key)):
        raise HTTPException(status_code=403, detail="Invalid or missing X-API-Key header")


# ── Scheduled scraper ──────────────────────────────────────────────────────────
async def _scheduler_loop() -> None:
    """Periodically triggers both scrape jobs (skills.sh + awesome-openclaw)."""
    interval = settings.scheduler_interval_hours * 3600
    logger.info(
        f"Scheduler started — will scrape every {settings.scheduler_interval_hours}h "
        f"({int(interval)}s)"
    )
    while True:
        await asyncio.sleep(interval)
        logger.info("Scheduler: triggering periodic scrape cycle")
        for scrape_fn, label in [
            (run_scrape_job, "skills.sh"),
            (run_awesome_scrape_job, "awesome-openclaw"),
        ]:
            try:
                pool = await get_pool()
                async with pool.acquire() as conn:
                    # Skip if a job is already running
                    running = await conn.fetchrow(
                        "SELECT id FROM scrape_jobs "
                        "WHERE status IN ('pending', 'running') LIMIT 1"
                    )
                    if running:
                        logger.info(
                            f"Scheduler: skipping {label} — job {running['id']} "
                            f"already in progress"
                        )
                        continue
                    job = await conn.fetchrow(
                        "INSERT INTO scrape_jobs DEFAULT VALUES "
                        "RETURNING id, status, skills_found, error_message, "
                        "started_at, completed_at"
                    )
                job_id = str(job["id"])
                task = asyncio.create_task(scrape_fn(job_id))
                _running_tasks.add(task)
                task.add_done_callback(_running_tasks.discard)
                logger.info(f"Scheduler: launched {label} scrape job {job_id}")
                # Wait for this job to finish before starting the next source
                await task
            except Exception:
                logger.exception(f"Scheduler: {label} scrape failed")


# ── Lifespan ───────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _scheduler_task
    try:
        await init_db()
    except Exception as exc:
        logger.warning(f"Database init failed on startup (will retry on first request): {exc}")

    # Start the periodic scheduler if enabled
    if settings.scheduler_enabled:
        _scheduler_task = asyncio.create_task(_scheduler_loop())
        logger.info("Built-in scrape scheduler is ENABLED")
    else:
        logger.info("Built-in scrape scheduler is DISABLED")

    yield

    # Cancel scheduler
    if _scheduler_task and not _scheduler_task.done():
        _scheduler_task.cancel()
        try:
            await _scheduler_task
        except asyncio.CancelledError:
            pass

    # Gracefully wait for any in-flight scrape tasks before Cloud Run shuts down
    if _running_tasks:
        logger.info(f"Shutdown: waiting for {len(_running_tasks)} background task(s)…")
        await asyncio.gather(*_running_tasks, return_exceptions=True)
    await close_db()


# ── App ────────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Skills Scraper Microservice",
    description=(
        "Scrapes skills.sh and stores results in PostgreSQL. "
        "POST /api/scrape to start a job; poll GET /api/scrape/{job_id} for status."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)


# ── Helpers ────────────────────────────────────────────────────────────────────
def _job_out(job) -> ScrapeJobResponse:
    return ScrapeJobResponse(
        id=str(job["id"]),
        status=job["status"],
        skills_found=job["skills_found"],
        error_message=job["error_message"],
        started_at=job["started_at"],
        completed_at=job["completed_at"],
    )


# ══════════════════════════════════════════════════════════════════════════════
# System endpoints
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/health", tags=["System"], summary="Health check")
async def health_check():
    """Used by Cloud Run / load balancers to verify the service is alive."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.fetchval("SELECT 1")
    return {"status": "healthy"}


@app.get("/api/scheduler", tags=["System"], summary="Scheduler status")
async def scheduler_status():
    """Returns the current state of the built-in scrape scheduler."""
    running = _scheduler_task is not None and not _scheduler_task.done()
    return {
        "enabled": settings.scheduler_enabled,
        "running": running,
        "interval_hours": settings.scheduler_interval_hours,
    }


# ══════════════════════════════════════════════════════════════════════════════
# Scrape-job endpoints
# ══════════════════════════════════════════════════════════════════════════════

@app.post(
    "/api/scrape",
    response_model=ScrapeJobResponse,
    status_code=202,
    tags=["Scrape"],
    dependencies=[Depends(require_api_key)],
    summary="Trigger a new scrape job",
)
async def trigger_scrape():
    """
    Starts a background scrape of skills.sh and saves results to PostgreSQL.

    Returns **202 Accepted** immediately with a `job_id`.
    Poll `GET /api/scrape/{job_id}` to check progress.

    Only one job can run at a time — returns **409** if one is already active.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        running = await conn.fetchrow(
            "SELECT id FROM scrape_jobs WHERE status IN ('pending', 'running') LIMIT 1"
        )
        if running:
            raise HTTPException(
                status_code=409,
                detail=f"Job {running['id']} is already in progress",
            )

        job = await conn.fetchrow(
            """
            INSERT INTO scrape_jobs DEFAULT VALUES
            RETURNING id, status, skills_found, error_message, started_at, completed_at
            """
        )

    job_id = str(job["id"])

    # asyncio.create_task keeps the coroutine alive independently of the request.
    # This is critical for Cloud Run where BackgroundTasks can be killed after
    # the response is sent if the instance scales down.
    task = asyncio.create_task(run_scrape_job(job_id))
    _running_tasks.add(task)
    task.add_done_callback(_running_tasks.discard)

    logger.info(f"Scrape job {job_id} created and launched")
    return _job_out(job)


@app.post(
    "/api/scrape/awesome",
    response_model=ScrapeJobResponse,
    status_code=202,
    tags=["Scrape"],
    dependencies=[Depends(require_api_key)],
    summary="Trigger an awesome-openclaw-skills scrape job",
)
async def trigger_awesome_scrape():
    """
    Fetches VoltAgent/awesome-openclaw-skills README and category files,
    parses all skill entries, and upserts them with source='awesome-openclaw'.

    Returns **202 Accepted** immediately with a `job_id`.
    Poll `GET /api/scrape/{job_id}` to check progress.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        job = await conn.fetchrow(
            """
            INSERT INTO scrape_jobs DEFAULT VALUES
            RETURNING id, status, skills_found, error_message, started_at, completed_at
            """
        )

    job_id = str(job["id"])
    task = asyncio.create_task(run_awesome_scrape_job(job_id))
    _running_tasks.add(task)
    task.add_done_callback(_running_tasks.discard)

    logger.info(f"Awesome scrape job {job_id} created and launched")
    return _job_out(job)


@app.get(
    "/api/scrape",
    response_model=list[ScrapeJobResponse],
    tags=["Scrape"],
    summary="List recent scrape jobs",
)
async def list_jobs():
    """Returns the 20 most recent scrape jobs."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        jobs = await conn.fetch(
            """
            SELECT id, status, skills_found, error_message, started_at, completed_at
            FROM scrape_jobs
            ORDER BY started_at DESC
            LIMIT 20
            """
        )
    return [_job_out(j) for j in jobs]


@app.get(
    "/api/scrape/{job_id}",
    response_model=ScrapeJobResponse,
    tags=["Scrape"],
    summary="Get scrape job status",
)
async def get_job(job_id: str):
    """Poll this endpoint to track progress of a running scrape."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        job = await conn.fetchrow(
            """
            SELECT id, status, skills_found, error_message, started_at, completed_at
            FROM scrape_jobs WHERE id = $1
            """,
            job_id,
        )
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return _job_out(job)


# ══════════════════════════════════════════════════════════════════════════════
# Skills query endpoints
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/skills/count", tags=["Skills"], summary="Total skills in DB")
async def count_skills():
    pool = await get_pool()
    async with pool.acquire() as conn:
        count = await conn.fetchval("SELECT COUNT(*) FROM skills")
    return {"count": count}


@app.get(
    "/api/skills",
    response_model=SkillsListResponse,
    tags=["Skills"],
    summary="List / search skills",
)
async def list_skills(
    page: int = Query(1, ge=1, description="Page number (1-based)"),
    page_size: int = Query(50, ge=1, le=500, description="Items per page"),
    q: Optional[str] = Query(None, description="Full-text search on name, source, or id"),
):
    """
    Returns a paginated list of skills.
    Use `?q=python` to search by name, source, or skill ID.
    """
    pool = await get_pool()
    offset = (page - 1) * page_size

    async with pool.acquire() as conn:
        if q:
            term = f"%{q}%"
            total = await conn.fetchval(
                "SELECT COUNT(*) FROM skills WHERE name ILIKE $1 OR source ILIKE $1 OR id ILIKE $1 OR category ILIKE $1",
                term,
            )
            rows = await conn.fetch(
                """
                SELECT id, skill_id, name, description, category, installs,
                       source, source_url, is_installed, created_at, updated_at
                FROM skills
                WHERE name ILIKE $1 OR source ILIKE $1 OR id ILIKE $1 OR category ILIKE $1
                ORDER BY installs DESC, name
                LIMIT $2 OFFSET $3
                """,
                term,
                page_size,
                offset,
            )
        else:
            total = await conn.fetchval("SELECT COUNT(*) FROM skills")
            rows = await conn.fetch(
                """
                SELECT id, skill_id, name, description, category, installs,
                       source, source_url, is_installed, created_at, updated_at
                FROM skills
                ORDER BY installs DESC, name
                LIMIT $1 OFFSET $2
                """,
                page_size,
                offset,
            )

    return SkillsListResponse(
        items=[SkillItem(**dict(r)) for r in rows],
        total=total,
        page=page,
        page_size=page_size,
        has_next=offset + page_size < total,
    )


@app.get(
    "/api/skills/{skill_id:path}",
    response_model=SkillItem,
    tags=["Skills"],
    summary="Get a single skill by ID",
)
async def get_skill(skill_id: str):
    """
    Look up one skill by its full ID (e.g. `obra/superpowers/brainstorming`).
    The `:path` converter allows slashes in the ID.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, skill_id, name, description, category, installs,
                   source, source_url, is_installed, created_at, updated_at
            FROM skills WHERE id = $1
            """,
            skill_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Skill not found")
    return SkillItem(**dict(row))
