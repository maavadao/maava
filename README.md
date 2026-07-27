# Agent Platform

Multi-tenant platform for custom agents, skills, MCP servers, and chat.
Serverless architecture (Cloud Run + Cloud SQL + GCS + Secret Manager); see `PLAN.md` for the full spec.

## Repo layout

```
apps/api/        Python FastAPI service — API + agent runtime (Cloud Run)
apps/web/        Next.js frontend (placeholder for Phase 1)
packages/shared/ Shared contracts (placeholder)
db/migrations/   Ordered SQL migrations (schema + RLS)
db/migrate.py    Minimal migration runner
infra/terraform/ GCP infra skeleton
```

## Local development

Requires Docker and Python 3.12+.

```bash
make db-up        # start local Postgres 16
make migrate      # apply db/migrations/*.sql
make api          # run FastAPI with reload on :8080
make test         # two-tenant RLS leakage suite + unit tests
```

## Non-negotiable invariants (enforced by tests)

1. Every query path runs inside an explicit transaction that does
   `SET LOCAL app.org_id / app.user_id` — never plain `SET`, never autocommit
   (transaction pooling shares sessions across tenants).
2. The app connects as `app_api`, a role with no BYPASSRLS, no DDL, and no
   UPDATE/DELETE on `messages` (append-only).
3. Secrets never touch Postgres or GCS — only Secret Manager resource names.
4. User-uploaded content never executes inside the API process.
