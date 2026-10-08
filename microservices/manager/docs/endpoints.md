# mawa Manager — Endpoint Reference

> HTTP reference for the control-plane API implemented in [app/](app/)
> (FastAPI, `app.main:app`). Design rationale: [design.md](design.md).
> Interactive OpenAPI docs are served at `/docs` when the app is running.

| Service | Default listen | Purpose |
| --- | --- | --- |
| manager Control Plane | `:8000` (uvicorn default) | Tenant auth, orgs, RBAC, instance management, RBAC-gated proxy to each instance's mawa core launcher |

---

## 1. Conventions

- **Base path:** all endpoints are under `/v1` (except `GET /healthz`).
- **Content type:** JSON in, JSON out (`Content-Type: application/json`).
- **Auth:** `Authorization: Bearer <token>` where the token is either
  - a **JWT access token** (from `/v1/auth/login` / `/register` / `/refresh`), or
  - an **API key** starting with `pck_` (from `POST /v1/orgs/{org_id}/api-keys`).
- **Error envelope:** every error is
  `{"error": {"code": "<machine-code>", "message": "<human text>"}}` with a
  matching 4xx/5xx status. Common codes: `unauthorized` (401), `forbidden`
  (403), `not_found` (404), `conflict` (409), `quota_exceeded` (409),
  `invalid_permissions` / `invalid_role` / `invalid_plan` (400),
  `unavailable` (503), `bad_gateway` (502).
- **List envelope:** list endpoints return `{"data": [...], "next_cursor": null}`.
- **Validation errors** (malformed bodies) return FastAPI's standard `422`.
- **Audit:** every mutating call, every instance-proxy call, and every
  permission denial is recorded and visible via
  `GET /v1/orgs/{org_id}/audit-logs`.

### Permission scoping

Each protected endpoint lists a **Permission**. It is checked against the
caller's effective permission set, resolved per request as:

```text
perms = platform_admin_bypass(user)          # staff: all permissions
      ∪ org_role(user, org)                  # from org membership
      ∪ instance_role(user, instance)        # per-instance binding, if any
if api_key: perms ∩= api_key.permissions     # keys only narrow
```

Built-in roles: `owner`, `admin`, `operator`, `developer`, `viewer`,
`billing`. Full role → permission matrix: [design.md §3.3](design.md).

---

## 2. System

| Method | Path | Auth | Response |
| --- | --- | --- | --- |
| `GET` | `/healthz` | none | `200 {"status":"ok"}` |

---

## 3. Auth & identity

### `POST /v1/auth/register` — public

Create a user account, optionally with a first organization (caller becomes
its `owner`).

```jsonc
// request
{
  "email": "me@acme.com",
  "password": "password123",        // min 8 chars
  "display_name": "Jo",             // optional
  "org_name": "Acme Corp"           // optional — creates org + owner membership
}
// 201 response
{
  "access_token": "eyJ…",
  "refresh_token": "…",
  "token_type": "bearer",
  "expires_in": 1800
}
```

Errors: `409 conflict` (email taken).

### `POST /v1/auth/login` — public

```jsonc
{"email": "me@acme.com", "password": "password123"}
```

`200` → same token envelope as register. Errors: `401 unauthorized`
(bad credentials), `403 forbidden` (account disabled).

### `POST /v1/auth/refresh` — public

```jsonc
{"refresh_token": "…"}
```

`200` → new token pair. **Refresh tokens are single-use** — the old one is
revoked on success; reuse returns `401`.

### `POST /v1/auth/logout` — public

```jsonc
{"refresh_token": "…"}
```

`200 {"status":"ok"}` — revokes the refresh token (idempotent).

### `GET /v1/me` — any authenticated principal

```jsonc
// 200
{
  "user": {
    "id": "uuid", "email": "me@acme.com", "display_name": "Jo",
    "is_platform_admin": false, "status": "active", "created_at": "…"
  },
  "memberships": [
    {"org_id": "uuid", "org_slug": "acme", "org_name": "Acme Corp", "role": "owner"}
  ]
}
```

### `PATCH /v1/me` — JWT only (API keys rejected with 403)

```jsonc
{
  "display_name": "New Name",            // optional
  "current_password": "old",             // required with new_password
  "new_password": "newpassword123"       // optional, min 8
}
```

`200` → updated `user` object. Errors: `400 invalid_password`.

---

## 4. Organizations

### `POST /v1/orgs` — any authenticated user (JWT only)

Creator becomes `owner`.

```jsonc
{"name": "Acme Corp", "slug": "acme"}    // slug: ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$, ≤63
```

`201` → org object. Errors: `409` (slug taken).

### `GET /v1/orgs` — any authenticated user

Lists the caller's own orgs. `200 {"data":[{id,slug,name,status,created_at}]}`.

| Method | Path | Permission | Body | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/orgs/{org_id}` | `org:read` | – | `200` org object |
| `PATCH` | `/v1/orgs/{org_id}` | `org:update` | `{"name": "…"}` | `200` org object |
| `DELETE` | `/v1/orgs/{org_id}` | `org:delete` | – | `200 {"status":"ok"}` — refused with `409` while live instances exist |

---

## 5. Members & invitations

| Method | Path | Permission | Body | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/orgs/{org_id}/members` | `org:members:read` | – | `200 {"data":[{user_id,email,display_name,role,joined_at}]}` |
| `PATCH` | `/v1/orgs/{org_id}/members/{user_id}` | `org:members:manage` | `{"role":"admin"}` | `200 ok` — `409` when demoting the last `owner` |
| `DELETE` | `/v1/orgs/{org_id}/members/{user_id}` | `org:members:manage` | – | `200 ok` — `409` when removing the last `owner` |
| `POST` | `/v1/orgs/{org_id}/invitations` | `org:members:manage` | `{"email":"…","role":"viewer"}` | `201` (below) |
| `GET` | `/v1/orgs/{org_id}/invitations` | `org:members:manage` | – | `200 {"data":[…]}` (pending only) |
| `DELETE` | `/v1/orgs/{org_id}/invitations/{invitation_id}` | `org:members:manage` | – | `200 ok` |
| `POST` | `/v1/invitations/accept` | any authenticated user | `{"token":"…"}` | `200 ok` |

`role` accepts any built-in or org-custom role name.

```jsonc
// 201 POST /v1/orgs/{org_id}/invitations
{
  "id": "uuid", "email": "new@acme.com",
  "expires_at": "…",                // TTL 7 days (MANAGER_INVITATION_TTL_DAYS)
  "accepted_at": null, "created_at": "…",
  "token": "…"                      // returned ONCE; deliver to the invitee
}
```

Accept errors: `400 invalid_invitation` (bad/expired), `403` (token issued to
a different email), `409` (already a member).

---

## 6. Roles

Built-in roles are listed alongside custom ones but are immutable.

| Method | Path | Permission | Body | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/orgs/{org_id}/roles` | `org:roles:read` | – | `200 {"data":[{id,name,description,is_system,permissions[]}]}` |
| `POST` | `/v1/orgs/{org_id}/roles` | `org:roles:manage` | `{"name":"log-reader","description":"…","permissions":["instance:read","instance:logs:read"]}` | `201` role object |
| `PATCH` | `/v1/orgs/{org_id}/roles/{role_id}` | `org:roles:manage` | `{"description":"…","permissions":[…]}` (both optional) | `200` role object |
| `DELETE` | `/v1/orgs/{org_id}/roles/{role_id}` | `org:roles:manage` | – | `200 ok` |

Errors: `400 invalid_permissions` (unknown permission id),
`400 immutable` (built-in role), `409` (name clash, or role still bound to
members/bindings on delete).

Valid permission ids are the catalog in [app/rbac.py](app/rbac.py)
(`org:*` and `instance:*` — see design doc §3.2).

---

## 7. API keys

| Method | Path | Permission | Body | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/orgs/{org_id}/api-keys` | `org:apikeys:read` | – | `200 {"data":[…]}` (metadata + prefix only, never the secret) |
| `POST` | `/v1/orgs/{org_id}/api-keys` | `org:apikeys:manage` (JWT only) | below | `201` (below) |
| `DELETE` | `/v1/orgs/{org_id}/api-keys/{key_id}` | `org:apikeys:manage` | – | `200 ok` (revoke) |

```jsonc
// request
{
  "name": "ci-deploy",
  "permissions": ["instance:read", "instance:logs:read"],  // must be ⊆ your own grants
  "instance_ids": ["uuid", …],       // optional — restrict to specific instances
  "expires_at": "2026-12-31T00:00:00Z"  // optional
}
// 201 response
{
  "id": "uuid", "name": "ci-deploy", "key_prefix": "pck_Ed1ux5RU",
  "permissions": [...], "instance_ids": null,
  "expires_at": null, "last_used_at": null, "created_at": "…",
  "secret": "pck_…"                  // returned ONCE — store it now
}
```

Errors: `400 invalid_permissions` (requesting more than the creator holds),
`400 invalid_instance`, `403` (an API key cannot mint API keys).

At request time a key's permissions are **intersected with its creator's
current grants** — demoting or removing the creator instantly degrades the key.

---

## 8. Instances

### `POST /v1/orgs/{org_id}/instances` — `instance:create`

```jsonc
// request
{
  "name": "Support Bot",
  "slug": "support-bot",       // unique per org, dns-safe, ≤63
  "region": "default",         // optional
  "plan": "free",              // optional plan name; cheapest active plan if omitted
  "labels": {"env": "prod"}    // optional
}
// 201 response
{
  "id": "uuid", "org_id": "uuid", "name": "Support Bot", "slug": "support-bot",
  "region": "default",
  "status": "provisioning",    // provisioning|running|degraded|suspended|stopped|deleting|error
  "status_message": "waiting for deployment",
  "labels": {"env": "prod"}, "desired_version": null,
  "created_at": "…", "updated_at": "…"
}
```

Creation also generates the instance's launcher password (platform-held,
encrypted — customers never see it) and its in-cluster endpoint records.
Errors: `409 conflict` (slug taken), `409 quota_exceeded` (plan instance cap).

### Other instance routes

| Method | Path | Permission | Body | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/orgs/{org_id}/instances?status=` | `instance:read` | – | `200 {"data":[…]}` |
| `GET` | `/v1/instances/{instance_id}` | `instance:read` | – | `200` instance object |
| `PATCH` | `/v1/instances/{instance_id}` | `instance:update` | `{"name":…,"labels":…,"plan":…}` (all optional) | `200` instance object |
| `DELETE` | `/v1/instances/{instance_id}` | `instance:delete` | – | `200 ok` — soft-delete, status → `deleting` |
| `POST` | `/v1/instances/{instance_id}/suspend` | `instance:lifecycle` | – | `200` instance object (status `suspended`; idempotent) |
| `POST` | `/v1/instances/{instance_id}/resume` | `instance:lifecycle` | – | `200` instance object — `409` if not suspended |

### Instance-scoped role bindings

Grant a user a different (usually higher) role on **one** instance without
changing their org-wide role.

| Method | Path | Permission | Body | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/instances/{instance_id}/role-bindings` | `org:members:read` | – | `200 {"data":[{user_id,email,role,created_at}]}` |
| `PUT` | `/v1/instances/{instance_id}/role-bindings/{user_id}` | `org:members:manage` | `{"role":"operator"}` | `200 ok` (create or update) |
| `DELETE` | `/v1/instances/{instance_id}/role-bindings/{user_id}` | `org:members:manage` | – | `200 ok` |

---

## 9. Instance proxy (launcher passthrough)

All under `/v1/instances/{instance_id}/…`. The control plane checks the
mapped permission, authenticates to the instance's launcher with the
platform-held password (cached session cookie, auto re-login on 401), forwards
the request, and returns the launcher's response body unchanged. Request and
response shapes are therefore the **launcher's own** — see
[launcher-api.md](launcher-api.md).

Proxy-layer errors (before the launcher is reached):

- `409 conflict` — instance status is not `running`/`degraded`
- `503 unavailable` — no endpoint/credentials provisioned, or launcher unreachable
- `502 bad_gateway` — launcher login failed
- `404 not_found` — subpath is not in the allowlist below

### Route → permission map

| Method | manager subpath | → Launcher route | Permission |
| --- | --- | --- | --- |
| `GET` | `gateway/status` | `GET /api/gateway/status` | `instance:read` |
| `POST` | `gateway/start` · `gateway/stop` · `gateway/restart` | same | `instance:lifecycle` |
| `GET` | `gateway/logs?log_offset=&log_run_id=` | `GET /api/gateway/logs` | `instance:logs:read` |
| `POST` | `gateway/logs/clear` | same | `instance:lifecycle` |
| `GET` | `config` | `GET /api/config` | `instance:config:read` |
| `PUT` / `PATCH` | `config` | same | `instance:config:write` |
| `POST` | `config/reset` | same | `instance:config:write` |
| `POST` | `config/test-command-patterns` | same | `instance:config:read` |
| `GET` | `models` · `models/catalog` | same | `instance:models:read` |
| `POST` | `models` · `models/fetch` · `models/default` · `models/test-inline` · `models/{i}/test` | same | `instance:models:write` |
| `PUT` / `DELETE` | `models/{i}` | same | `instance:models:write` |
| `DELETE` | `models/catalog/{id}` | same | `instance:models:write` |
| `GET` | `channels/catalog` · `channels/{name}/config` | same | `instance:channels:read` |
| `POST` | `weixin/flows` · `wecom/flows` | same | `instance:channels:write` |
| `GET` | `weixin/flows/{id}` · `wecom/flows/{id}` | same | `instance:channels:write` |
| `GET` | `sessions` · `sessions/{id}` | same | `instance:sessions:read` |
| `DELETE` | `sessions/{id}` | same | `instance:sessions:delete` |
| `GET` | `skills` · `skills/search` · `skills/{name}` | same | `instance:skills:read` |
| `POST` | `skills/install` · `skills/import` | same | `instance:skills:write` |
| `DELETE` | `skills/{name}` | same | `instance:skills:write` |
| `GET` | `tools` · `tools/web-search-config` | same | `instance:tools:read` |
| `PUT` | `tools/{name}/state` · `tools/web-search-config` | same | `instance:tools:write` |
| `GET` | `oauth/providers` | same | `instance:config:read` |
| `POST` | `oauth/login` · `oauth/logout` · `oauth/flows/{id}/poll` | same | `instance:secrets:manage` |
| `GET` | `oauth/flows/{id}` | same | `instance:secrets:manage` |
| `GET` | `pico/info` | same | `instance:read` |
| `POST` | `pico/setup` · `pico/token` | same | `instance:secrets:manage` |
| `GET` | `media/{id}` | `GET /pico/media/{id}` | `instance:console` |

**Not exposed to tenants** (404): the launcher's `/api/auth/*`,
`/api/system/*`, `/api/update` — these are platform-operator concerns.
WebSocket console bridging (`/pico/ws`) is not implemented yet.

Example:

```bash
curl -X POST localhost:8000/v1/instances/$INSTANCE/gateway/restart \
  -H "Authorization: Bearer $TOKEN"
# → launcher response: {"status":"ok","pid":1234}
```

---

## 10. Audit log

### `GET /v1/orgs/{org_id}/audit-logs` — `org:audit:read`

Query params: `instance_id`, `action`, `limit` (default 50, max 100).
Newest first.

```jsonc
// 200
{
  "data": [
    {
      "id": 42,
      "org_id": "uuid", "instance_id": "uuid",
      "actor_user_id": "uuid", "actor_api_key_id": null,
      "action": "instance.proxy.post",     // e.g. org.member.update, instance.create, …
      "target": "/gateway/restart",
      "request_meta": {"method": "POST", "path": "/v1/instances/…", "ip": "…", "user_agent": "…"},
      "result": "ok",                      // ok | denied | error
      "created_at": "…"
    }
  ],
  "next_cursor": null
}
```

Recorded actions include: `org.create/update/delete`, `org.member.update/remove`,
`org.invitation.create/revoke`, `org.role.create/update/delete`,
`org.apikey.create/revoke`, `instance.create/update/delete/suspend/resume`,
`instance.role_binding.put/delete`, and `instance.proxy.<method>` for every
proxied launcher call. Permission denials are recorded with `result: "denied"`.

---

## 11. Quick reference card

```text
GET  /healthz

POST /v1/auth/{register,login,refresh,logout}
GET/PATCH /v1/me

POST/GET /v1/orgs                       GET/PATCH/DELETE /v1/orgs/{org}
GET /v1/orgs/{org}/members              PATCH/DELETE /v1/orgs/{org}/members/{user}
POST/GET /v1/orgs/{org}/invitations     DELETE /v1/orgs/{org}/invitations/{id}
POST /v1/invitations/accept
GET/POST /v1/orgs/{org}/roles           PATCH/DELETE /v1/orgs/{org}/roles/{id}
GET/POST /v1/orgs/{org}/api-keys        DELETE /v1/orgs/{org}/api-keys/{id}
GET /v1/orgs/{org}/audit-logs

POST/GET /v1/orgs/{org}/instances
GET/PATCH/DELETE /v1/instances/{id}     POST /v1/instances/{id}/{suspend,resume}
GET /v1/instances/{id}/role-bindings    PUT/DELETE /v1/instances/{id}/role-bindings/{user}

# proxied to the instance's mawa core launcher (RBAC-gated, see §9):
GET/POST /v1/instances/{id}/gateway/{status,start,stop,restart,logs,logs/clear}
GET/PUT/PATCH/POST /v1/instances/{id}/config[/reset|/test-command-patterns]
GET/POST/PUT/DELETE /v1/instances/{id}/models[...]
GET /v1/instances/{id}/channels/...     POST/GET /v1/instances/{id}/{weixin,wecom}/flows[/{id}]
GET/DELETE /v1/instances/{id}/sessions[/{id}]
GET/POST/DELETE /v1/instances/{id}/skills[...]
GET/PUT /v1/instances/{id}/tools[...]
GET/POST /v1/instances/{id}/oauth/...
GET/POST /v1/instances/{id}/pico/{info,setup,token}
GET /v1/instances/{id}/media/{id}
```
