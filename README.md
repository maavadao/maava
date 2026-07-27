# Agent Platform

Multi-tenant platform for custom agents, skills, MCP servers, and chat.
Serverless architecture (Cloud Run + Cloud SQL + GCS + Secret Manager); see `PLAN.md` for the full spec.

## Repo layout

```text
apps/api/          Python FastAPI service — API + agent runtime (Cloud Run)
apps/web/          Next.js frontend (placeholder for Phase 1)
packages/shared/   Shared contracts (placeholder)
db/migrations/     Ordered SQL migrations (schema + RLS)
db/migrate.py      Minimal migration runner
demo-frontend-app/ Minimal Next.js demo client for the API (dev only)
infra/terraform/   GCP infra skeleton
```

## Getting started

### Prerequisites

- Docker (with Compose)
- Python 3.12+
- Node.js 20+ (for the demo frontend)
- An [OpenRouter](https://openrouter.ai) API key (for chat)

### Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e "apps/api[dev]"

make db-up        # start local Postgres 16
make migrate      # apply db/migrations/*.sql
```

### Run the API

```bash
export AP_OPENROUTER_API_KEY=sk-or-...   # needed for chat; other routes work without it
make api                                 # FastAPI with reload on http://localhost:8080
```

Verify: `curl http://localhost:8080/healthz` → `{"ok": true}`.

### Run the demo frontend

In a second terminal (with the venv activated):

```bash
make demo-seed      # seed a demo org/user, prints a 24h dev JWT
make demo-frontend  # npm install + Next.js dev server on http://localhost:3000
```

Open <http://localhost:3000>, paste the token from `make demo-seed`, and click
**Connect**. You can create agents and chat with them (SSE streaming).
See `demo-frontend-app/README.md` for details.

### Test and lint

```bash
make test         # two-tenant RLS leakage suite + unit tests
make lint         # ruff
```

## Non-negotiable invariants (enforced by tests)

1. Every query path runs inside an explicit transaction that does
   `SET LOCAL app.org_id / app.user_id` — never plain `SET`, never autocommit
   (transaction pooling shares sessions across tenants).
2. The app connects as `app_api`, a role with no BYPASSRLS, no DDL, and no
   UPDATE/DELETE on `messages` (append-only).
3. Secrets never touch Postgres or GCS — only Secret Manager resource names.
4. User-uploaded content never executes inside the API process.
