# mawa-platform

Multi-tenant service for custom agents, skills, MCP servers and chat.
Serverless architecture (Cloud Run + Cloud SQL + GCS + Secret Manager); see `PLAN.md` for the full spec.

Part of [mawa](https://github.com/mawadao/mawa), the open-source agent platform behind mawaDao: a community-owned ecosystem of agentic AI for education, where developers build and list agents for free and the community shares in what they earn.

## Repo layout

```text
app/                    FastAPI service: API + agent runtime (Cloud Run)
tests/                  Two-tenant RLS leakage suite and API tests
db/migrations/          Ordered SQL migrations (schema + RLS)
db/migrate.py           Minimal migration runner
examples/demo-frontend/ Minimal Next.js demo client for the API (dev only)
infra/terraform/        GCP infra skeleton
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
pip install -e ".[dev]"

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
See `examples/demo-frontend/README.md` for details.

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

## Contributing

Read the [contributing guide](https://github.com/mawadao/mawa/blob/main/CONTRIBUTING.md) before opening a pull request.
This service lives in the `mawa` repository; pull requests go there. Releases are tagged
`platform-vX.Y.Z` as described in [RELEASING.md](https://github.com/mawadao/mawa/blob/main/RELEASING.md).

## Licence

Apache 2.0. See [LICENSE](../../LICENSE).
