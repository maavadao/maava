# Skills Scraper Microservice

Scrapes **skills.sh** and persists all discovered skills into PostgreSQL (Supabase).
Designed to run on **Google Cloud Run** and integrate with microservices architectures via a simple REST API.

---

## Architecture

```
Your Website / Other Services
        │
        │  REST  (X-API-Key header)
        ▼
  Cloud Run  (skills-scraper)
        │
        ├─ POST /api/scrape  →  creates DB job record
        │                       launches asyncio background task
        │
        ├─ GET  /api/scrape/{id}  →  poll status
        ├─ GET  /api/skills       →  query scraped data
        │
        ▼
  Supabase PostgreSQL
   ├── skills        (scraped skill records)
   └── scrape_jobs   (job tracking)
```

---

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET`  | `/health` | no | Health check for load balancers |
| `POST` | `/api/scrape` | **yes** | Trigger a new scrape job |
| `GET`  | `/api/scrape` | no | List recent jobs |
| `GET`  | `/api/scrape/{job_id}` | no | Poll job status |
| `GET`  | `/api/skills` | no | List skills (paginated, searchable) |
| `GET`  | `/api/skills/count` | no | Total skills in DB |
| `GET`  | `/api/skills/{id}` | no | Get single skill by ID |

Interactive docs: `https://<your-service-url>/docs`

### Trigger a scrape

```bash
curl -X POST https://<url>/api/scrape \
  -H "X-API-Key: your-secret-key"
# → 202 { "id": "uuid", "status": "pending", ... }
```

### Poll status

```bash
curl https://<url>/api/scrape/<job_id>
# → { "status": "running", "skills_found": 12400, ... }
# → { "status": "completed", "skills_found": 62509, ... }
```

### Search skills

```bash
curl "https://<url>/api/skills?q=python&page=1&page_size=50"
```

---

## Database Schema

```sql
-- Auto-created on startup
CREATE TABLE skills (
    id          TEXT PRIMARY KEY,        -- e.g. "obra/superpowers/brainstorming"
    name        TEXT,
    source      TEXT,
    raw_data    JSONB,                   -- full API payload
    scraped_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE scrape_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status          TEXT DEFAULT 'pending',   -- pending | running | completed | failed
    skills_found    INTEGER DEFAULT 0,
    error_message   TEXT,
    started_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | **yes** | Full PostgreSQL connection string |
| `API_KEY` | no | When set, `POST /api/scrape` requires `X-API-Key` header |
| `SCRAPE_DELAY` | no | Delay between API requests in seconds (default `0.5`) |
| `SCRAPE_REQUEST_LIMIT` | no | `limit` param sent to skills.sh (default `70000`) |

---

## Local Development

```bash
# 1. Copy env file
cp .env.example .env
# Edit .env with your DATABASE_URL

# 2. Run with Docker Compose
docker compose up --build

# 3. Visit
open http://localhost:8080/docs
```

---

## Deploy to Google Cloud Run

### One-time setup

```bash
# Authenticate
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# Enable APIs
gcloud services enable run.googleapis.com cloudbuild.googleapis.com containerregistry.googleapis.com

# Store secrets (recommended over env vars for production)
echo -n "postgresql://..." | gcloud secrets create DATABASE_URL --data-file=-
echo -n "your-api-key"    | gcloud secrets create SKILLS_API_KEY --data-file=-
```

### Manual deploy

```bash
# Build & push
docker build -t gcr.io/YOUR_PROJECT_ID/skills-scraper .
docker push gcr.io/YOUR_PROJECT_ID/skills-scraper

# Deploy
gcloud run deploy skills-scraper \
  --image gcr.io/YOUR_PROJECT_ID/skills-scraper \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --memory 512Mi \
  --timeout 3600 \
  --min-instances 1 \
  --set-env-vars DATABASE_URL="postgresql://...",API_KEY="your-key"
```

> **Why `--min-instances 1`?**  
> The scrape runs as a background asyncio task after your request returns.
> Cloud Run scales to zero when idle, which would kill an in-progress scrape.
> Keeping one instance alive ensures the job completes.

### CI/CD via Cloud Build

Create a trigger in Cloud Build pointing to your repo with `cloudbuild.yaml`.
Set substitution variables `_DATABASE_URL` and `_API_KEY` in the trigger config.

---

## Calling from Other Microservices

```python
import httpx

SKILLS_SERVICE_URL = "https://skills-scraper-xxxx-uc.a.run.app"
API_KEY = "your-secret-key"

async def trigger_scrape():
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{SKILLS_SERVICE_URL}/api/scrape",
            headers={"X-API-Key": API_KEY},
        )
        return resp.json()  # {"id": "...", "status": "pending", ...}

async def get_skills(q: str = "", page: int = 1):
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{SKILLS_SERVICE_URL}/api/skills",
            params={"q": q, "page": page, "page_size": 100},
        )
        return resp.json()  # {"items": [...], "total": 62509, ...}
```
