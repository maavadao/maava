# maava Manager API — Design (RBAC + Instance Management)

> Multi-tenant control plane that manages customer maava core instances running on
> Kubernetes. Each **instance** = one launcher (`:18800`) + managed gateway
> (`:18790`) pod, isolated per customer namespace. The control plane never
> exposes the launcher/gateway directly — every instance operation goes through
> this API, which enforces RBAC and then proxies to the instance's launcher API
> using platform-held credentials.
>
> Scope of this document: **management API + RBAC + database schema**.
> Deployment/provisioning flow (K8s controllers, operators) is out of scope but
> the schema below already reserves the tables for it.

---

## 1. Architecture at a glance

```text
customer ──► manager API (this doc) ──► RBAC check ──► instance proxy ──► launcher :18800 ──► gateway :18790
                 │                                        ▲
                 ├─ Postgres (tenants, RBAC, instances)   │ service-account session
                 └─ audit log                             │ (platform-held launcher password)
```

- The platform owns each instance's launcher dashboard password (generated at
  provision time, stored encrypted). Customers never see it; they authenticate
  to the **manager API** only.
- The manager API maintains a launcher session cookie per instance (re-login on
  401) and forwards allowed calls.
- Instance-level RBAC decides *which* launcher endpoints a caller may reach
  (e.g. a `viewer` can read config and logs, only an `admin` can rotate tokens
  or restart the gateway).

## 2. Auth model

| Mechanism | Use | Notes |
| --- | --- | --- |
| `Authorization: Bearer <JWT>` | Human users (dashboard / CLI) | Short-lived access token + refresh token. JWT carries `sub` (user_id) only — roles are resolved server-side per request. |
| `Authorization: Bearer pck_<key>` | Machine / CI access | API keys are org-scoped, carry an explicit permission subset (never more than the creating user's), hashed at rest (SHA-256), prefix retained for display. |
| mTLS / internal token | Control-plane ⇄ K8s workers | Not exposed to customers. |

All endpoints are under `/v1`. Errors use `{"error":{"code":"…","message":"…"}}`.
List endpoints support `?limit=` (≤100), `?cursor=` (opaque), and return
`{"data":[…],"next_cursor":…}`.

## 3. RBAC model

Three scopes, most-specific wins (deny does not exist — grants are additive):

1. **Platform** — internal staff (`platform_admin`, `platform_support`).
2. **Organization** — role per member of an org.
3. **Instance** — optional per-instance role binding that overrides/augments the
   org role for that one instance (e.g. a contractor who is `viewer` org-wide
   but `operator` on a single instance).

### 3.1 Built-in roles

| Role | Scope | Summary |
| --- | --- | --- |
| `owner` | org | Everything, incl. billing, member management, instance delete. Exactly ≥1 per org. |
| `admin` | org / instance | Full instance management incl. secrets, lifecycle, config write, member management (org scope only). |
| `operator` | org / instance | Day-2 ops: lifecycle (start/stop/restart gateway), config write, models/channels/skills/tools management, logs, sessions. No secret rotation, no delete, no member management. |
| `developer` | org / instance | Config read, models/skills/tools read+write, sessions read, logs read. No lifecycle, no channel secrets. |
| `viewer` | org / instance | Read-only: status, config (secrets masked), logs, sessions list. |
| `billing` | org | Billing/subscription endpoints only. |

Custom roles are supported: a named set of permissions, org-owned
(`roles` + `role_permissions` tables).

### 3.2 Permission catalog

Permissions are strings checked per endpoint. Wildcards are expansion-time only
(a role stores concrete permissions).

```text
org:read  org:update  org:delete
org:members:read  org:members:manage
org:roles:read    org:roles:manage
org:apikeys:read  org:apikeys:manage
org:billing:read  org:billing:manage
org:audit:read

instance:create   instance:read     instance:update   instance:delete
instance:lifecycle            # gateway start/stop/restart, instance suspend/resume
instance:config:read          # GET /api/config (secrets masked)
instance:config:write         # PUT/PATCH config, reset
instance:secrets:manage       # pico token rotate, channel secrets, oauth logins
instance:models:read  instance:models:write
instance:channels:read instance:channels:write
instance:skills:read  instance:skills:write
instance:tools:read   instance:tools:write
instance:sessions:read instance:sessions:delete
instance:logs:read
instance:console              # open proxied dashboard / pico websocket
```

### 3.3 Role → permission matrix (built-ins)

| Permission | owner | admin | operator | developer | viewer |
| --- | :-: | :-: | :-: | :-: | :-: |
| instance:create/delete | ✅ | ✅ | – | – | – |
| instance:read | ✅ | ✅ | ✅ | ✅ | ✅ |
| instance:update | ✅ | ✅ | ✅ | – | – |
| instance:lifecycle | ✅ | ✅ | ✅ | – | – |
| instance:config:read | ✅ | ✅ | ✅ | ✅ | ✅ |
| instance:config:write | ✅ | ✅ | ✅ | – | – |
| instance:secrets:manage | ✅ | ✅ | – | – | – |
| instance:models:* | ✅ | ✅ | ✅ | ✅ | read |
| instance:channels:* | ✅ | ✅ | ✅ | read | read |
| instance:skills:* / tools:* | ✅ | ✅ | ✅ | ✅ | read |
| instance:sessions:read | ✅ | ✅ | ✅ | ✅ | ✅ |
| instance:sessions:delete | ✅ | ✅ | ✅ | – | – |
| instance:logs:read | ✅ | ✅ | ✅ | ✅ | ✅ |
| instance:console | ✅ | ✅ | ✅ | ✅ | – |
| org:members:manage / roles:manage | ✅ | ✅ | – | – | – |
| org:billing:manage | ✅ | – | – | – | – |
| org:audit:read | ✅ | ✅ | – | – | – |

Resolution algorithm per request:

```text
perms = platform_role_perms(user)                       # staff bypass
      ∪ org_role_perms(user, org)
      ∪ instance_role_perms(user, instance)             # if instance-scoped route
      ∪ api_key_perms ∩ (above)                          # api keys can only narrow
allow iff required_permission ∈ perms
```

## 4. API surface

### 4.1 Auth & identity

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| POST | `/v1/auth/register` | public | Email + password; creates user (+ optional first org). |
| POST | `/v1/auth/login` | public | Returns `{access_token, refresh_token, expires_in}`. Rate-limited. |
| POST | `/v1/auth/refresh` | public | Rotates refresh token. |
| POST | `/v1/auth/logout` | authed | Revokes refresh token. |
| GET | `/v1/me` | authed | Profile + org memberships + effective roles. |
| PATCH | `/v1/me` | authed | Name, password change (requires current password). |

### 4.2 Organizations & members

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/v1/orgs` | authed (creator becomes `owner`) |
| GET | `/v1/orgs` | authed (own memberships) |
| GET | `/v1/orgs/{org_id}` | `org:read` |
| PATCH | `/v1/orgs/{org_id}` | `org:update` |
| DELETE | `/v1/orgs/{org_id}` | `org:delete` (owner only; refuses while instances exist) |
| GET | `/v1/orgs/{org_id}/members` | `org:members:read` |
| PATCH | `/v1/orgs/{org_id}/members/{user_id}` | `org:members:manage` — change role; cannot demote last owner |
| DELETE | `/v1/orgs/{org_id}/members/{user_id}` | `org:members:manage` |
| POST | `/v1/orgs/{org_id}/invitations` | `org:members:manage` — `{email, role}` → mailed token, 7-day TTL |
| GET/DELETE | `/v1/orgs/{org_id}/invitations[/{id}]` | `org:members:manage` |
| POST | `/v1/invitations/accept` | authed — `{token}` |

### 4.3 Roles & API keys

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/v1/orgs/{org_id}/roles` | `org:roles:read` — built-ins + custom |
| POST | `/v1/orgs/{org_id}/roles` | `org:roles:manage` — `{name, description, permissions[]}` |
| PATCH/DELETE | `/v1/orgs/{org_id}/roles/{role_id}` | `org:roles:manage` — built-ins immutable; delete refused while bound |
| GET | `/v1/orgs/{org_id}/api-keys` | `org:apikeys:read` — prefix + metadata only |
| POST | `/v1/orgs/{org_id}/api-keys` | `org:apikeys:manage` — `{name, permissions[], expires_at?, instance_ids?}`; secret returned **once** |
| DELETE | `/v1/orgs/{org_id}/api-keys/{key_id}` | `org:apikeys:manage` |

### 4.4 Instances (metadata + RBAC bindings)

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| POST | `/v1/orgs/{org_id}/instances` | `instance:create` | `{name, region?, plan_id?, labels{}}`. Returns instance with `status:"provisioning"` — actual K8s rollout handled by the (future) deployment layer via the `deployments` tables. |
| GET | `/v1/orgs/{org_id}/instances` | `instance:read` | Filter `?status=&label=`. |
| GET | `/v1/instances/{instance_id}` | `instance:read` | Includes `status` ∈ `provisioning\|running\|degraded\|suspended\|stopped\|deleting\|error`, endpoints, plan, resource usage summary. |
| PATCH | `/v1/instances/{instance_id}` | `instance:update` | Rename, labels, plan change request. |
| DELETE | `/v1/instances/{instance_id}` | `instance:delete` | Soft-delete → deprovision job. |
| POST | `/v1/instances/{instance_id}/suspend` / `/resume` | `instance:lifecycle` | Scales workload to 0 / back. |
| GET | `/v1/instances/{instance_id}/role-bindings` | `org:members:read` | |
| PUT | `/v1/instances/{instance_id}/role-bindings/{user_id}` | `org:members:manage` | `{role}` — instance-scoped override. |
| DELETE | `/v1/instances/{instance_id}/role-bindings/{user_id}` | `org:members:manage` | |

### 4.5 Instance proxy (mapped to the maava core launcher API)

All under `/v1/instances/{instance_id}/…`; the control plane injects the
launcher session and forwards. Response bodies are the launcher's, unchanged
unless noted. Mapping to the launcher reference:

| manager route | → Launcher route | Permission |
| --- | --- | --- |
| GET `/gateway/status` | GET `/api/gateway/status` | `instance:read` |
| POST `/gateway/start` / `/stop` / `/restart` | same | `instance:lifecycle` |
| GET `/gateway/logs?log_offset=&log_run_id=` | GET `/api/gateway/logs` | `instance:logs:read` |
| POST `/gateway/logs/clear` | same | `instance:lifecycle` |
| GET `/config` | GET `/api/config` | `instance:config:read` (secrets already masked by launcher) |
| PUT `/config`, PATCH `/config` | same | `instance:config:write` |
| POST `/config/reset` | same | `instance:config:write` |
| POST `/config/test-command-patterns` | same | `instance:config:read` |
| GET `/models`, GET `/models/catalog` | same | `instance:models:read` |
| POST/PUT/DELETE `/models…`, POST `/models/default`, `/models/fetch`, `/models/{i}/test`, `/models/test-inline` | same | `instance:models:write` |
| GET `/channels/catalog`, GET `/channels/{name}/config` | same | `instance:channels:read` |
| POST `/{weixin,wecom}/flows`, GET `…/flows/{id}` | same | `instance:channels:write` |
| GET `/sessions`, GET `/sessions/{id}` | same | `instance:sessions:read` |
| DELETE `/sessions/{id}` | same | `instance:sessions:delete` |
| GET `/skills`, `/skills/{name}`, `/skills/search` | same | `instance:skills:read` |
| POST `/skills/install`, `/skills/import`, DELETE `/skills/{name}` | same | `instance:skills:write` |
| GET `/tools`, `/tools/web-search-config` | same | `instance:tools:read` |
| PUT `/tools/{name}/state`, `/tools/web-search-config` | same | `instance:tools:write` |
| GET `/oauth/providers` | same | `instance:config:read` |
| POST `/oauth/login`, `/oauth/logout`, flows | same | `instance:secrets:manage` |
| GET `/pico/info` | same | `instance:read` |
| POST `/pico/setup`, `/pico/token` | same | `instance:secrets:manage` |
| GET `/console/ws` (WebSocket) | GET `/pico/ws` | `instance:console` — control plane upgrades and bridges. |
| GET `/media/{id}` | GET `/pico/media/{id}` | `instance:console` |

Deliberately **not** exposed to tenants: `/api/auth/*` (platform owns the
launcher password), `/api/system/launcher-config`, `/api/update`,
`/api/system/autostart` — these are platform-operator concerns
(`platform_admin` can reach them under `/v1/admin/instances/{id}/…`).

### 4.6 Audit log

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/v1/orgs/{org_id}/audit-logs?actor=&instance_id=&action=&from=&to=` | `org:audit:read` |

Every mutating request (and every proxy call) writes one row: actor (user or
API key), org, instance, action (e.g. `instance.gateway.restart`,
`instance.config.patch`), request metadata, result.

---

## 5. Database schema (PostgreSQL)

Conventions: `uuid` PKs (`gen_random_uuid()`), `timestamptz` audit columns,
soft delete via `deleted_at` where noted. Secrets encrypted at the application
layer (envelope encryption, KMS key id stored alongside) — columns marked
`/* enc */`.

```sql
-- ===================================================================
-- Identity & tenancy
-- ===================================================================
CREATE TABLE users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email           citext NOT NULL UNIQUE,
    password_hash   text,                        -- null when SSO-only
    display_name    text NOT NULL DEFAULT '',
    is_platform_admin boolean NOT NULL DEFAULT false,
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','disabled','pending_verification')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);

CREATE TABLE organizations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            citext NOT NULL UNIQUE,      -- url-safe, used in k8s namespace naming
    name            text NOT NULL,
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','deleting')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);

CREATE TABLE refresh_tokens (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      text NOT NULL,               -- sha256
    expires_at      timestamptz NOT NULL,
    revoked_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    user_agent      text,
    ip              inet
);
CREATE INDEX ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- ===================================================================
-- RBAC
-- ===================================================================
-- Built-in roles have org_id NULL and is_system = true; custom roles are org-owned.
CREATE TABLE roles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid REFERENCES organizations(id) ON DELETE CASCADE,
    name            text NOT NULL,               -- 'owner','admin','operator',… or custom
    description     text NOT NULL DEFAULT '',
    is_system       boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, name),
    CHECK (is_system = (org_id IS NULL))
);

CREATE TABLE permissions (
    id              text PRIMARY KEY             -- 'instance:lifecycle', 'org:members:manage', …
);

CREATE TABLE role_permissions (
    role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id   text NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

-- Org membership carries the org-scope role.
CREATE TABLE org_memberships (
    org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id         uuid NOT NULL REFERENCES roles(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id)
);
CREATE INDEX ON org_memberships (user_id);

-- Instance-scope overrides / narrow grants.
CREATE TABLE instance_role_bindings (
    instance_id     uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id         uuid NOT NULL REFERENCES roles(id),
    created_by      uuid REFERENCES users(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (instance_id, user_id)
);

CREATE TABLE invitations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email           citext NOT NULL,
    role_id         uuid NOT NULL REFERENCES roles(id),
    token_hash      text NOT NULL UNIQUE,
    invited_by      uuid NOT NULL REFERENCES users(id),
    expires_at      timestamptz NOT NULL,
    accepted_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, email)
);

CREATE TABLE api_keys (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            text NOT NULL,
    key_prefix      text NOT NULL,               -- 'pck_ab12…' first 12 chars, display only
    key_hash        text NOT NULL UNIQUE,        -- sha256 of full secret
    permissions     text[] NOT NULL,             -- explicit subset, validated against permissions table
    instance_ids    uuid[],                      -- NULL = all org instances
    created_by      uuid NOT NULL REFERENCES users(id),
    expires_at      timestamptz,
    last_used_at    timestamptz,
    revoked_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON api_keys (org_id) WHERE revoked_at IS NULL;

-- ===================================================================
-- Instances (the managed maava core launcher+gateway units)
-- ===================================================================
CREATE TABLE plans (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text NOT NULL UNIQUE,        -- 'free','pro','enterprise'
    cpu_millicores  integer NOT NULL,
    memory_mb       integer NOT NULL,
    storage_gb      integer NOT NULL,
    max_instances   integer NOT NULL DEFAULT 1,  -- per-org cap on this plan
    price_cents_month integer NOT NULL DEFAULT 0,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE instances (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organizations(id),
    plan_id         uuid NOT NULL REFERENCES plans(id),
    name            text NOT NULL,               -- customer-visible
    slug            citext NOT NULL,             -- dns/namespace-safe
    region          text NOT NULL DEFAULT 'default',
    status          text NOT NULL DEFAULT 'provisioning'
                    CHECK (status IN ('provisioning','running','degraded',
                                      'suspended','stopped','deleting','error')),
    status_message  text NOT NULL DEFAULT '',
    labels          jsonb NOT NULL DEFAULT '{}',
    desired_version text,                        -- picoclaw image tag customer is pinned to
    created_by      uuid REFERENCES users(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz,
    UNIQUE (org_id, slug)
);
CREATE INDEX ON instances (org_id) WHERE deleted_at IS NULL;
CREATE INDEX ON instances (status);

-- Platform-held credentials for reaching the instance's launcher/gateway.
CREATE TABLE instance_credentials (
    instance_id     uuid PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
    launcher_password text NOT NULL,             /* enc */
    launcher_session  text,                      /* enc — cached picoclaw_launcher_auth cookie */
    session_expires_at timestamptz,
    gateway_pidfile_token text,                  /* enc — bearer for POST /reload */
    pico_token      text,                        /* enc — Sec-Websocket-Protocol token */
    kms_key_id      text NOT NULL,
    rotated_at      timestamptz NOT NULL DEFAULT now()
);

-- Where the control plane reaches the instance inside the cluster.
CREATE TABLE instance_endpoints (
    instance_id     uuid PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
    launcher_url    text NOT NULL,               -- http://svc.ns.svc.cluster.local:18800
    gateway_url     text NOT NULL,               -- …:18790
    external_url    text,                        -- customer-facing ingress (webhooks: /webhook/line etc.)
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Periodic health snapshots (from launcher /api/gateway/status + gateway /health).
CREATE TABLE instance_health (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    instance_id     uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
    gateway_status  text NOT NULL,               -- stopped|starting|running|restarting|error
    healthy         boolean NOT NULL,
    detail          jsonb NOT NULL DEFAULT '{}',
    observed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON instance_health (instance_id, observed_at DESC);

-- ===================================================================
-- Audit
-- ===================================================================
CREATE TABLE audit_logs (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id          uuid REFERENCES organizations(id) ON DELETE SET NULL,
    instance_id     uuid REFERENCES instances(id) ON DELETE SET NULL,
    actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    actor_api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,
    action          text NOT NULL,               -- 'instance.gateway.restart', 'org.member.update', …
    target          text NOT NULL DEFAULT '',    -- resource path / identifier
    request_meta    jsonb NOT NULL DEFAULT '{}', -- ip, user_agent, method, path
    result          text NOT NULL DEFAULT 'ok'   -- ok | denied | error
                    CHECK (result IN ('ok','denied','error')),
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_logs (org_id, created_at DESC);
CREATE INDEX ON audit_logs (instance_id, created_at DESC);

-- ===================================================================
-- FUTURE: Kubernetes deployment layer (reserved now, wired up later)
-- ===================================================================
-- Target clusters the platform can schedule instances onto.
CREATE TABLE clusters (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text NOT NULL UNIQUE,
    region          text NOT NULL,
    api_server_url  text NOT NULL,
    ca_cert         text NOT NULL,
    credentials     text NOT NULL,               /* enc — SA token / kubeconfig */
    kms_key_id      text NOT NULL,
    capacity        jsonb NOT NULL DEFAULT '{}', -- schedulable cpu/mem summary
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','cordoned','draining','offline')),
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Published picoclaw images customers can run.
CREATE TABLE releases (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    version         text NOT NULL UNIQUE,        -- 'v1.4.2'
    image           text NOT NULL,               -- registry ref for launcher image
    channel         text NOT NULL DEFAULT 'stable'
                    CHECK (channel IN ('stable','beta','deprecated')),
    notes           text NOT NULL DEFAULT '',
    published_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per instance describing where/how it is (to be) deployed.
CREATE TABLE instance_deployments (
    instance_id     uuid PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
    cluster_id      uuid NOT NULL REFERENCES clusters(id),
    namespace       text NOT NULL,               -- 'pc-<org_slug>-<instance_slug>'
    release_id      uuid NOT NULL REFERENCES releases(id),
    desired_replicas integer NOT NULL DEFAULT 1, -- 0 = suspended
    resources       jsonb NOT NULL DEFAULT '{}', -- overrides on plan defaults
    storage_class   text,
    pvc_name        text,                        -- persists ~/.picoclaw (config, sessions, skills)
    ingress_host    text,                        -- <instance>.customer-domain
    generation      bigint NOT NULL DEFAULT 1,   -- bumped on every desired-state change
    observed_generation bigint NOT NULL DEFAULT 0,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cluster_id, namespace)
);

-- Reconciliation / rollout history (one row per apply attempt).
CREATE TABLE deployment_operations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id     uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
    kind            text NOT NULL
                    CHECK (kind IN ('provision','upgrade','scale','suspend',
                                    'resume','migrate','deprovision')),
    from_release_id uuid REFERENCES releases(id),
    to_release_id   uuid REFERENCES releases(id),
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','succeeded','failed','rolled_back')),
    error           text NOT NULL DEFAULT '',
    requested_by    uuid REFERENCES users(id),
    started_at      timestamptz,
    finished_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON deployment_operations (instance_id, created_at DESC);
```

### Seed data sketch

```sql
INSERT INTO permissions (id) VALUES
 ('org:read'),('org:update'),('org:delete'),
 ('org:members:read'),('org:members:manage'),
 ('org:roles:read'),('org:roles:manage'),
 ('org:apikeys:read'),('org:apikeys:manage'),
 ('org:billing:read'),('org:billing:manage'),('org:audit:read'),
 ('instance:create'),('instance:read'),('instance:update'),('instance:delete'),
 ('instance:lifecycle'),('instance:config:read'),('instance:config:write'),
 ('instance:secrets:manage'),
 ('instance:models:read'),('instance:models:write'),
 ('instance:channels:read'),('instance:channels:write'),
 ('instance:skills:read'),('instance:skills:write'),
 ('instance:tools:read'),('instance:tools:write'),
 ('instance:sessions:read'),('instance:sessions:delete'),
 ('instance:logs:read'),('instance:console');
-- built-in roles (org_id NULL, is_system true) + role_permissions per §3.3
```

---

## 6. Design decisions worth calling out

1. **Launcher password is platform-owned.** The launcher's single-password auth
   is unusable for multi-user RBAC, so the platform treats it as an internal
   service credential (`instance_credentials`) and layers real RBAC in front.
2. **Proxy, don't reimplement.** The manager routes in §4.5 map 1:1 onto launcher
   endpoints, so the control plane stays a thin policy layer and inherits
   launcher-side validation (`validateConfig`, secret masking, etc.).
3. **Instance-scoped role bindings** cover the common manager ask ("give this
   contractor access to one bot only") without complicating the org model.
4. **API keys narrow, never widen** — stored as an explicit permission array
   intersected with live role resolution, so revoking a user's role instantly
   degrades their keys too.
5. **Deployment tables are desired-state + generation counters**, ready for a
   reconciler/operator pattern later: the future deploy API only has to write
   `instance_deployments` / `deployment_operations`; nothing in the management
   API changes.
6. **`instance_health`** is fed by polling each launcher's
   `/api/gateway/status` and gateway `/health`; it backs the `status` field and
   dashboards without hammering instances per user request.
