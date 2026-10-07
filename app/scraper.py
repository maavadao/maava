import asyncio
import logging
import re
from typing import Dict, Any

import httpx

from app.config import settings
from app.database import get_pool

# ── Awesome OpenClaw scraper constants ────────────────────────────────────────
AWESOME_README_URL = (
    "https://raw.githubusercontent.com/VoltAgent/awesome-openclaw-skills/main/README.md"
)
AWESOME_CAT_BASE_URL = (
    "https://raw.githubusercontent.com/VoltAgent/awesome-openclaw-skills/main/categories/"
)

# Matches lines like:
#   - [slug](https://github.com/openclaw/skills/tree/main/skills/AUTHOR/SLUG/SKILL.md) - Description
_SKILL_LINE_RE = re.compile(
    r"[-•*]\s*\[([^\]]+)\]\("
    r"https://github\.com/openclaw/skills/tree/main/skills/"
    r"([^/\)]+)/([^/\)]+)/SKILL\.md\)"
    r"[^\-–\n]*[-–]\s*(.{3,})",
    re.IGNORECASE,
)

# Matches links to category files: (categories/something.md)
_CAT_FILE_RE = re.compile(r"\(categories/([^)]+\.md)\)")

# Section headers (## or ###)
_SECTION_RE = re.compile(r"^#{2,3}\s+(.+)$", re.MULTILINE)


def _normalize_category(name: str) -> str:
    """Convert 'Git & GitHub' → 'git-and-github'."""
    return (
        name.strip()
        .lower()
        .replace(" & ", "-and-")
        .replace("&", "-and-")
        .replace(" ", "-")
        .replace("(", "")
        .replace(")", "")
        .replace("/", "-")
        .replace(",", "")
        .strip("-")
    )


def _collect_awesome(skills_dict: Dict[str, Any], content: str, category: str) -> None:
    """Parse skill entries from a markdown block and add them to skills_dict."""
    norm_cat = _normalize_category(category)
    for m in _SKILL_LINE_RE.finditer(content):
        _display = m.group(1).strip()
        author = m.group(2).strip()
        slug = m.group(3).strip()
        desc = m.group(4).strip()

        _id = f"awesome-openclaw/{author}/{slug}"
        if _id not in skills_dict:
            skills_dict[_id] = {
                "skill_id": slug,
                "name": slug,
                "description": desc,
                "category": norm_cat,
                "installs": 0,
                "source": "awesome-openclaw",
                "source_url": (
                    f"https://github.com/openclaw/skills/tree/main/skills/{author}/{slug}/SKILL.md"
                ),
                "is_installed": False,
            }

logger = logging.getLogger(__name__)


async def _upsert_batch(conn, skills_dict: Dict[str, Any]) -> None:
    """Bulk-upsert all skills in skills_dict into the database."""
    if not skills_dict:
        return

    records = [
        (
            skill_id,
            skill.get("skill_id") or skill_id.split("/")[-1],
            skill.get("name", ""),
            skill.get("description"),
            skill.get("category", ""),
            skill.get("installs", 0),
            skill.get("source", ""),
            skill.get("source_url"),
            skill.get("is_installed", False),
        )
        for skill_id, skill in skills_dict.items()
    ]

    await conn.executemany(
        """
        INSERT INTO skills (id, skill_id, name, description, category, installs, source, source_url, is_installed, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (id) DO UPDATE SET
            skill_id     = EXCLUDED.skill_id,
            name         = EXCLUDED.name,
            description  = EXCLUDED.description,
            category     = EXCLUDED.category,
            installs     = EXCLUDED.installs,
            source       = EXCLUDED.source,
            source_url   = EXCLUDED.source_url,
            is_installed = EXCLUDED.is_installed,
            updated_at   = NOW()
        """,
        records,
    )


async def _fetch_query(client: httpx.AsyncClient, query: str) -> list:
    """Fetch skills from the upstream API for one query string."""
    try:
        resp = await client.get(
            settings.scrape_api_url,
            params={"q": query, "limit": settings.scrape_request_limit},
            timeout=30.0,
        )
        resp.raise_for_status()
        skills = resp.json().get("skills", [])
        logger.info(f"Query '{query}' → {len(skills)} skills")
        return skills
    except Exception as exc:
        logger.warning(f"Query '{query}' failed: {exc}")
        return []


def _collect(skills_dict: Dict[str, Any], skills: list) -> None:
    """Deduplicate and add skills to the accumulator dict."""
    for skill in skills:
        sid = skill.get("id") or f"{skill.get('source')}/{skill.get('name')}"
        if sid and sid not in skills_dict:
            skills_dict[sid] = skill


async def run_scrape_job(job_id: str) -> None:
    """
    Full scrape workflow.
    Launched as an asyncio Task so it outlives the HTTP request lifecycle.
    """
    pool = await get_pool()
    skills_dict: Dict[str, Any] = {}

    # Mark running
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE scrape_jobs SET status = 'running' WHERE id = $1", job_id
        )

    try:
        prefix_chars = "abcdefghijklmnopqrstuvwxyz0123456789"
        vowels = "aeiou"

        async with httpx.AsyncClient() as client:

            # ── Strategy 1: <char><vowel>  (180 queries) ──────────────────────
            for char in prefix_chars:
                for v in vowels:
                    skills = await _fetch_query(client, f"{char}{v}")
                    _collect(skills_dict, skills)
                    await asyncio.sleep(settings.scrape_delay)

                # Persist + update progress after every character group
                async with pool.acquire() as conn:
                    await _upsert_batch(conn, skills_dict)
                    await conn.execute(
                        "UPDATE scrape_jobs SET skills_found = $1 WHERE id = $2",
                        len(skills_dict),
                        job_id,
                    )
                logger.info(
                    f"[{job_id}] After '{char}': {len(skills_dict)} unique skills"
                )

            # ── Strategy 2: <char><consonant>  (only if still below target) ──
            if len(skills_dict) < settings.scrape_target:
                logger.info(f"[{job_id}] Running strategy 2 (common consonant bigrams)…")
                for char in prefix_chars:
                    for second in "snrtlc":
                        if second not in vowels:
                            skills = await _fetch_query(client, f"{char}{second}")
                            _collect(skills_dict, skills)
                            await asyncio.sleep(settings.scrape_delay)

                    async with pool.acquire() as conn:
                        await _upsert_batch(conn, skills_dict)
                        await conn.execute(
                            "UPDATE scrape_jobs SET skills_found = $1 WHERE id = $2",
                            len(skills_dict),
                            job_id,
                        )

        # Final persist & mark completed
        async with pool.acquire() as conn:
            await _upsert_batch(conn, skills_dict)
            await conn.execute(
                """
                UPDATE scrape_jobs
                SET status = 'completed', skills_found = $1, completed_at = NOW()
                WHERE id = $2
                """,
                len(skills_dict),
                job_id,
            )

        logger.info(f"[{job_id}] Completed. Total unique skills: {len(skills_dict)}")

    except Exception as exc:
        logger.error(f"[{job_id}] Failed: {exc}", exc_info=True)
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE scrape_jobs
                SET status = 'failed', error_message = $1, completed_at = NOW()
                WHERE id = $2
                """,
                str(exc)[:2000],
                job_id,
            )


async def run_awesome_scrape_job(job_id: str) -> None:
    """
    Fetch VoltAgent/awesome-openclaw-skills README + category files.
    Parses all skill entries and upserts with source='awesome-openclaw'.
    """
    pool = await get_pool()
    skills_dict: Dict[str, Any] = {}

    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE scrape_jobs SET status = 'running' WHERE id = $1", job_id
        )

    try:
        async with httpx.AsyncClient(
            follow_redirects=True,
            headers={"User-Agent": "mawadao-skills-scraper/1.0"},
            timeout=30.0,
        ) as client:
            # Step 1: Fetch README
            logger.info(f"[{job_id}] Fetching awesome-openclaw-skills README…")
            resp = await client.get(AWESOME_README_URL)
            resp.raise_for_status()
            readme = resp.text

            # Step 2: Parse README sections → collect preview skills + category file links
            # re.split with capture group gives: [pre, header1, body1, header2, body2, ...]
            parts = _SECTION_RE.split(readme)
            cat_files: Dict[str, str] = {}  # filename -> category_name
            current_category = "general"

            for i, chunk in enumerate(parts):
                if i == 0:
                    continue  # pre-header content
                if i % 2 == 1:
                    current_category = chunk.strip()  # section header
                else:
                    _collect_awesome(skills_dict, chunk, current_category)
                    for m in _CAT_FILE_RE.finditer(chunk):
                        fname = m.group(1)
                        if fname not in cat_files:
                            cat_files[fname] = current_category

            logger.info(
                f"[{job_id}] README parsed: {len(skills_dict)} preview skills, "
                f"{len(cat_files)} category files"
            )

            # Step 3: Fetch each category file for full skill lists
            for fname, category in cat_files.items():
                try:
                    cat_resp = await client.get(f"{AWESOME_CAT_BASE_URL}{fname}")
                    cat_resp.raise_for_status()
                    _collect_awesome(skills_dict, cat_resp.text, category)
                    logger.info(
                        f"[{job_id}] '{fname}': total {len(skills_dict)} skills so far"
                    )
                    await asyncio.sleep(0.3)  # gentle rate limiting
                except Exception as exc:
                    logger.warning(f"[{job_id}] Failed to fetch {fname}: {exc}")

        # Step 4: Upsert all collected skills
        async with pool.acquire() as conn:
            await _upsert_batch(conn, skills_dict)
            await conn.execute(
                """
                UPDATE scrape_jobs
                SET status = 'completed', skills_found = $1, completed_at = NOW()
                WHERE id = $2
                """,
                len(skills_dict),
                job_id,
            )

        logger.info(
            f"[{job_id}] Awesome scrape completed. Total: {len(skills_dict)} unique skills"
        )

    except Exception as exc:
        logger.error(f"[{job_id}] Awesome scrape failed: {exc}", exc_info=True)
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE scrape_jobs
                SET status = 'failed', error_message = $1, completed_at = NOW()
                WHERE id = $2
                """,
                str(exc)[:2000],
                job_id,
            )
