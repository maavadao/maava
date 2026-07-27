# Agent Platform — Implementation Plan v1.1 (Serverless)

A multi-tenant web platform where users create custom agents, upload skills, register MCP servers, and chat. This document is the working spec for the engineering team and Claude Code.

---

## 1. Scope

**V1 (build now)**
- Orgs, users, roles (owner / admin / member / viewer)
- Custom agents: system prompt + model + params + attached skills + attached MCP servers
- Skills: upload as zip, versioned, instructions injected into context (no script execution yet)
- MCP: remote servers only (Streamable HTTP), tool discovery + caching, per-agent tool enable/disable
- Chat with streaming (SSE), persistent history, tool-call audit
- RBAC enforced with Postgres RLS + storage isolation

**V2 (design for, don't build yet)**
- Sandboxed skill script execution (gVisor/Firecracker)
- Sharing beyond org, marketplace
- pgvector chat search

**Explicit non-goals for V1:** stdio MCP, arbitrary code execution, public marketplace.

**Implementation language:** Python (FastAPI) for the API/runtime; Next.js for the web app.

---

## 2. High-Level Architecture

**Fully serverless: no always-on servers, no VPC-attached cache, no clusters.**

```
Browser (Next.js on Vercel / Firebase App Hosting)
        │ SSE / HTTPS
        ▼
API + Agent Runtime ── Cloud Run service (min-instances 1–2, CPU always-allocated,
        │              in-process memory cache + per-instance disk cache)
        │
        ├──────────────┬──────────────────┬──────────────────┐
        ▼              ▼                  ▼                  ▼
   Cloud SQL       GCS bucket        Secret Manager     OpenRouter
   Postgres        (skill artifacts, (MCP creds,        (hosted LLM gateway —
   + managed        optionally        OpenRouter         all models via one
   conn pooling     FUSE-mounted RO)  API key)           OpenAI-compatible API)

Async plane (all serverless):
  GCS upload finalized ──Eventarc──> Scan/Extract service (Cloud Run)
  Cloud Scheduler ──> Cloud Run Jobs: bucket janitor, MCP schema refresh,
                      MCP health checks, hard-delete/GDPR job
  (V2) Skill execution: ephemeral Cloud Run Job per run
       (gen1 exec env = gVisor sandbox, no creds, egress-restricted)
```

**Rules that everything else depends on:**
1. User-uploaded content never executes inside the API process.
2. The DB is the source of truth; the bucket is a dumb, immutable blob store.
3. Secrets never touch Postgres or GCS — Secret Manager only; DB stores the resource name.
4. The LLM can only call tools from an allowlist resolved at session start.

### Serverless deployment rules (Cloud Run)

- **DB connections are the scaling constraint.** Per instance: pool of 2–4 connections max. Cap `max-instances` on every service so `instances × pool ≤ ~80%` of Cloud SQL `max_connections`. Enable Cloud SQL managed connection pooling (or PgBouncer in transaction mode) from day one.
- **RLS + transaction pooling:** every request runs in an explicit transaction and sets tenant context with `SET LOCAL app.org_id / app.user_id` *inside that transaction*. Never plain `SET`, never autocommit — with transaction pooling the session may be shared across tenants. Add a CI test that asserts no query path runs outside a txn.
- **API service config:** `min-instances: 1–2` (kills cold starts, keeps caches warm), **CPU always-allocated** (required for smooth SSE streaming and background flushes between chunks), request timeout 30–60 min for long chats, concurrency tuned (~20–50; agent loops are I/O-bound).
- **Async plane:** Eventarc (GCS finalize → scan/extract service); Cloud Scheduler → Cloud Run Jobs for janitor, MCP schema refresh, health checks, GDPR hard-deletes. No cron on servers, no queues to manage in V1 (add Cloud Tasks if/when tool retries need it).
- **Egress:** Cloud Run reaches Cloud SQL via the connector; MCP servers are public HTTPS endpoints, so no VPC needed in V1. If a customer requires private MCP endpoints later, add Direct VPC egress on a dedicated service only.
- **V2 sandbox = ephemeral Cloud Run Job per skill execution** (gen1 execution environment for gVisor isolation, dedicated no-privilege service account, no Secret Manager access, egress denied by default). No GKE anywhere.

---

## 3. Database Schema (Postgres)

Implemented in `db/migrations/` — see `0002_schema.sql` (tables), `0003_roles.sql` (app role + grants), `0004_rls.sql` (RLS policies + helpers). Conventions: UUIDv7 primary keys (app-generated), `timestamptz`, soft delete via `deleted_at`, every tenant-scoped table has `org_id` and is under RLS.

### Row-Level Security

The API sets per-request context inside each transaction:

```sql
SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true);
```

Policies live in `0004_rls.sql`. Admin/owner escalation uses `app_current_role()`, a `SECURITY DEFINER` helper reading `memberships`. The app connects as `app_api`: **no BYPASSRLS**, no DDL, no UPDATE/DELETE on append-only tables (`messages`, `tool_calls`, `audit_events`).

---

## 4. Bucket Layout (GCS)

Single bucket per environment (`agentplatform-prod-artifacts`), uniform bucket-level access, no public access, CMEK optional later. All objects immutable once written.

```
gs://agentplatform-prod-artifacts/
├── tenants/
│   └── {org_id}/
│       ├── skills/{skill_id}/v{version}/
│       │   ├── artifact.zip            # original upload (retained for audit)
│       │   ├── SKILL.md                # extracted manifest + instructions
│       │   └── files/...               # extracted contents
│       ├── tool-outputs/{yyyy}/{mm}/{tool_call_id}.json   # outputs > 64 KB
│       └── uploads-tmp/{upload_id}.zip # signed-URL target; janitor deletes >24h
├── cas/sha256/{first2}/{checksum}/artifact.zip   # optional V1.5 dedupe
└── system/builtin-skills/{slug}/v{version}/...
```

Rules:
- **Upload flow:** client gets a signed PUT URL for `uploads-tmp/` → API validates + virus/static-scans → extracts to the versioned path → writes `skill_versions` row → deletes tmp object. Object first, DB row second; a janitor job removes orphaned objects with no row.
- **Lifecycle:** `uploads-tmp/` deleted after 1 day (janitor job — GCS lifecycle rules can't match the mid-path prefix); non-latest skill versions to Nearline after 90 days; `tool-outputs/` to Coldline after 30 days, delete after 180 (configurable per plan).
- **Access:** only the API and executor service accounts have bucket IAM. Clients only ever see short-lived signed URLs scoped to a single object. Bucket paths are never returned to the browser.

---

## 5. RBAC Model

### Roles & permission matrix (V1)

| Capability | owner | admin | member | viewer |
|---|---|---|---|---|
| Manage org, billing, members | ✅ | ✅ (not billing) | ❌ | ❌ |
| Create agents/skills/MCP | ✅ | ✅ | ✅ | ❌ |
| Edit/delete own resources | ✅ | ✅ | ✅ | ❌ |
| Edit/delete others' org-visible resources | ✅ | ✅ | ❌ | ❌ |
| Use org-visible agents (chat) | ✅ | ✅ | ✅ | ✅ |
| See others' private resources | ❌ | ❌ | ❌ | ❌ |
| View audit log | ✅ | ✅ | ❌ | ❌ |

Note: private resources are invisible even to owners/admins by default (privacy-first). Add an org policy flag later if enterprise customers demand admin visibility.

### Enforcement layers (all four required)

1. **API middleware** — authenticates JWT, loads membership, sets `app.org_id` / `app.user_id` on the DB connection, checks role for the route.
2. **Postgres RLS** — hard floor. A code bug cannot leak cross-tenant or cross-user rows.
3. **Storage** — tenant-prefixed paths, per-object signed URLs, no client access to bucket paths.
4. **Runtime allowlist** — at session start the runtime resolves, through RLS-guarded queries, exactly which skills and MCP tools this user+agent may use. That list is frozen for the session. The model cannot invoke anything outside it; any attempt is logged as `status='denied'` in `tool_calls`.

### Leakage rules (implemented as tests in `apps/api/tests/test_rls_leakage.py`)

- User A must never receive skill content, MCP tool schemas, tool outputs, or messages belonging to user B's private resources — asserted via integration tests that run as two tenants.
- A shared (org-visible) agent referencing the owner's **private** skill/MCP: V1 rule = attachment is only usable if the resource itself is org-visible. Block saving an org-visible agent with private attachments; show a "make attachments org-visible?" prompt. (Avoids the confused-deputy problem entirely in V1.)
- MCP `secret_ref` values are never serialized into API responses or logs.
- SSRF guard on MCP URLs: https only, resolve DNS and reject private/link-local ranges, re-validate on every connect (DNS rebinding).

---

## 6. Skill Caching (serverless: no Redis, no shared cache tier)

Skill versions are immutable and content-addressed by `checksum` — so **cache forever, never invalidate; a new version is a new key.** The shared cache tier is Postgres itself (indexed reads are 5–15 ms); per-instance caches absorb the rest. Memorystore/Redis is explicitly out.

### Layer 1 — In-process memory cache (metadata, hot path)
Cache the resolved agent→tool-list in an in-process LRU keyed by `(agent_id, agents.updated_at)` with a 5-minute TTL. Self-invalidating on agent edits; stale instances fall back to a cheap Postgres read. Per-message bucket reads: **zero**.

### Layer 2 — Per-instance disk cache (bytes, session start)
`/tmp/skills/sha256/{checksum}/` — extracted skill files, verified sha256, atomic rename, LRU-capped 1–2 GB. Alternative (preferred if skills grow large): Cloud Run GCS FUSE volume mount at `/mnt/skills`, read versioned paths directly. Choose one mechanism, not both. `min-instances: 1–2` keeps caches warm.

### Layer 3 — On-device cache (browser / future desktop app)
- **Browser:** skill *metadata* only, IndexedDB keyed by `skill_version_id`. Never file bytes, never other users' content. Clear on logout.
- **Desktop (future):** same content-addressed scheme in app data dir, synced via signed URLs, keychain-encrypted, wiped on sign-out.
- Never cache: MCP credentials, tool schemas of org resources on shared machines, other users' content.

### Sequence: session start (hydration)

```
1. POST /conversations/{id}/messages
2. Middleware: JWT -> open txn -> SET LOCAL app.org_id / app.user_id
3. In-process cache: agent toolset hit?  ── yes ──> 6
4. RLS-guarded queries: agent + agent_skills + agent_mcp + mcp_tool_schemas
5. Write toolset to in-process LRU (freeze allowlist for session)
6. Instance disk cache / FUSE mount: skill files present? miss -> GCS fetch + verify
7. Build system prompt (agent prompt + skill instructions) + tool definitions
8. Stream LLM via OpenRouter; tool calls dispatched only if in allowlist
9. Persist assistant message + tool_calls rows; update conversation.updated_at
```

Latency budget: steps 2–7 ≤ 200 ms cold instance, ≤ 30–50 ms warm.

---

## 7. Chat History

- `messages` is append-only; content stored as JSONB block arrays identical to what was sent/received from the LLM, so any conversation can be replayed exactly.
- Streaming: SSE. Persist user message before the LLM call; persist assistant message on stream completion; on disconnect persist partial with a `truncated: true` flag.
- Context building at read time: walk back by `seq`, budget by tokens, summarize/truncate old turns in memory — never mutate rows.
- Title auto-generation after first exchange (cheap model via OpenRouter).
- Soft delete conversations; hard-delete job after 30 days (GDPR delete = immediate hard delete of rows + tool-output objects).

---

## 8. MCP Runtime Rules

- Remote Streamable HTTP only. Official MCP SDK for the client.
- On register: handshake, `tools/list`, store schemas in `mcp_tool_schemas`, set `health`.
- Refresh schemas: on agent-builder open, and a daily Cloud Scheduler → Cloud Run Job. Diffs surfaced in UI.
- Per-session MCP connections from a dedicated egress service account; credentials pulled from Secret Manager at connect time, held in memory only.
- Tool outputs are untrusted input: size-capped, stripped of ANSI/control chars, never interpreted as instructions by the runtime. (Model-level injection defenses are a product feature: show tool calls in UI, confirm side-effectful tools.)
- Timeouts: connect 5 s, tool call 60 s (configurable per server), circuit-breaker to `unreachable` health after repeated failures.

---

## 9. LLM Layer — OpenRouter

OpenRouter is the multi-provider gateway; we build no gateway of our own. The API talks to `https://openrouter.ai/api/v1/chat/completions` through a thin client library:

- **Client wrapper responsibilities:** retries with backoff on 429/5xx, request/latency/cost logging into `token_usage`, per-org spend metering, streaming pass-through to SSE, kill-switch/config for allowed models.
- **Model catalog:** `agents.model` stores OpenRouter model IDs verbatim. Populate the picker from OpenRouter's `/models` API, **filtered to models whose `supported_parameters` include `tools`**. Cache with a daily Scheduler job.
- **Provider routing & fallbacks:** OpenRouter `provider` preferences / fallback routing per request; optionally pin `require_parameters: true`.
- **Keys & security:** one platform OpenRouter key in Secret Manager, loaded at instance start, never logged. Per-key spend limits as blast-radius cap. V2: per-org BYOK via `secret_ref`.
- **Usage/cost:** read `usage` into `messages.token_usage`; reconcile via OpenRouter's generation endpoint in a nightly job.
- **Caveats:** provider-specific tool-call edge cases (parallel calls, strict JSON schema) — conformance test per launch model; prompt caching is best-effort.

---

## 10. Build Phases

**Phase 0 — Foundations** ✅ scaffolded
- Monorepo (`apps/api` Python/FastAPI, `apps/web`, `packages/shared`), CI, Terraform skeleton
- Schema + RLS migrations, app role with least privilege
- Two-tenant leakage test harness (`apps/api/tests/`)

**Phase 1 — Agents & Chat**
- Agents CRUD + builder UI
- Agent loop + OpenRouter client wrapper + SSE streaming
- Conversations/messages persistence, title generation

**Phase 2 — Skills**
- Signed-URL upload flow, validation + scan pipeline, versioning
- Bucket janitor job, content-addressed instance cache
- Skill instructions injected into system prompt

**Phase 3 — MCP**
- Register/handshake/schema cache/health checks, SSRF guard
- Per-agent tool enable/disable, session allowlist enforcement, tool_calls audit

**Phase 4 — Hardening**
- Rate limits, quotas per plan, audit log UI, load test hydration path
- Pen-test checklist: RLS bypass attempts, SSRF, signed-URL scope, secret leakage in logs

**Definition of done for V1:** two-tenant leakage test suite green; p95 session-start hydration < 200 ms warm; a user can build an agent with 2 skills + 1 MCP server and hold a persistent streamed conversation.
