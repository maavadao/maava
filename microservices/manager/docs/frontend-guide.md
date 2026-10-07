# Frontend Developer Guide — mawaDao Agent Manager Dashboard

> How to build the customer dashboard against the control-plane API.
> Endpoint details: [endpoints.md](endpoints.md).
> Base URL below assumed as `https://api.example.com` (dev: `http://localhost:8000`).
> Interactive playground: `/docs` (Swagger UI) on the running API.

---

## 1. The mental model

Three nouns drive the whole UI:

1. **Org** — the tenant. A user can belong to several orgs with a different
   role in each. Everything else lives inside an org.
2. **Instance** — one managed mawaDao Agent core bot (launcher + gateway in the cloud).
   Has a lifecycle `status` you must render prominently.
3. **Permission** — what the current user may do *in the current org/instance*.
   The UI never hardcodes "is admin?" checks — it derives visibility from the
   role's permission list (see §5).

Instance pages are mostly a **remote control for the mawaDao Agent core launcher**: the
`/v1/instances/{id}/…` proxy routes return the launcher's own JSON unchanged,
so the dashboard's config/models/sessions screens are built against the
launcher payloads documented in [launcher-api.md](launcher-api.md).

---

## 2. Auth: tokens, storage, refresh

### What you get

`POST /v1/auth/register`, `/login`, `/refresh` all return:

```json
{"access_token": "eyJ…", "refresh_token": "…", "token_type": "bearer", "expires_in": 1800}
```

- **Access token**: JWT, ~30 min. Send on every request:
  `Authorization: Bearer <access_token>`.
- **Refresh token**: opaque, ~30 days, **single-use** — every call to
  `/v1/auth/refresh` revokes the old one and returns a new pair. Never fire
  two refreshes in parallel (the second gets `401`); serialize through one
  in-flight promise.

### Recommended handling

- Keep the access token in memory only. Persist the refresh token
  (`localStorage` is acceptable here; there is no cookie-based session).
- On app boot: if a refresh token exists → call `/v1/auth/refresh` → then
  `GET /v1/me`. If refresh fails with 401 → clear storage, show login.
- On any API `401` → run one refresh, retry the request once, else log out.

```ts
let accessToken: string | null = null;
let refreshing: Promise<void> | null = null;

async function refresh(): Promise<void> {
  refreshing ??= (async () => {
    const rt = localStorage.getItem("refresh_token");
    if (!rt) throw new Error("no session");
    const r = await fetch(`${API}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: rt }),
    });
    if (!r.ok) { localStorage.removeItem("refresh_token"); throw new Error("session expired"); }
    const t = await r.json();
    accessToken = t.access_token;
    localStorage.setItem("refresh_token", t.refresh_token); // rotated!
  })().finally(() => (refreshing = null));
  return refreshing;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const call = () =>
    fetch(`${API}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init.headers,
        Authorization: `Bearer ${accessToken}`,
      },
    });
  let r = await call();
  if (r.status === 401) { await refresh(); r = await call(); }
  if (!r.ok) throw await toApiError(r); // see §6
  return r.json();
}
```

Logout: `POST /v1/auth/logout {refresh_token}` then clear local state.

---

## 3. Core types

```ts
export type Uuid = string;

export interface User {
  id: Uuid; email: string; display_name: string;
  is_platform_admin: boolean; status: "active" | "disabled" | "pending_verification";
  created_at: string;
}

export interface Membership { org_id: Uuid; org_slug: string; org_name: string; role: string; }
export interface Me { user: User; memberships: Membership[]; }

export interface Org {
  id: Uuid; slug: string; name: string;
  status: "active" | "suspended" | "deleting"; created_at: string;
}

export type InstanceStatus =
  | "provisioning" | "running" | "degraded"
  | "suspended" | "stopped" | "deleting" | "error";

export interface Instance {
  id: Uuid; org_id: Uuid; name: string; slug: string; region: string;
  status: InstanceStatus; status_message: string;
  labels: Record<string, string>; desired_version: string | null;
  created_at: string; updated_at: string;
}

export interface Role {
  id: Uuid; name: string; description: string;
  is_system: boolean; permissions: string[];
}

export interface Member {
  user_id: Uuid; email: string; display_name: string; role: string; joined_at: string;
}

export interface ApiKeyMeta {
  id: Uuid; name: string; key_prefix: string; permissions: string[];
  instance_ids: string[] | null; expires_at: string | null;
  last_used_at: string | null; created_at: string;
}

export interface AuditEntry {
  id: number; org_id: Uuid | null; instance_id: Uuid | null;
  actor_user_id: Uuid | null; actor_api_key_id: Uuid | null;
  action: string; target: string;
  request_meta: { method: string; path: string; ip?: string; user_agent?: string };
  result: "ok" | "denied" | "error"; created_at: string;
}

export interface ListResponse<T> { data: T[]; next_cursor: string | null; }
export interface ApiError { error: { code: string; message: string } }
```

---

## 4. Screens & flows

### 4.1 Onboarding

1. **Sign up** — `POST /v1/auth/register` with `org_name` set: one call creates
   user + org + owner role and returns tokens. Go straight to the dashboard.
2. **Sign up via invitation** — register **without** `org_name` (the email must
   match the invitation), then `POST /v1/invitations/accept {token}` with the
   token from the invite link. Suggested route: `/invite?token=…` → if not
   logged in, show login/register first, then auto-accept.

### 4.2 Org switcher

`GET /v1/me` → `memberships[]` is your switcher content (name + your role).
Keep the active `org_id` in the URL (`/o/{org_slug}/…`) so links are shareable.
On switch, refetch roles + instances for that org.

### 4.3 Instances list — `/o/{org}/instances`

- `GET /v1/orgs/{org_id}/instances`. Render `status` as a badge:

| status | badge | UI behavior |
| --- | --- | --- |
| `provisioning` | spinner/amber | Poll list every ~5 s until it leaves this state. Disable all instance actions (proxy calls return `409`). |
| `running` | green | Everything enabled. |
| `degraded` | amber | Enabled, show `status_message` as a warning. |
| `suspended` | grey | Show **Resume** (needs `instance:lifecycle`). Proxy disabled. |
| `stopped` / `error` | red | Show `status_message`. Proxy disabled. |
| `deleting` | grey | Read-only, remove from list when it 404s. |

- **Create instance** dialog: `name`, auto-derived `slug`
  (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`, ≤63 — validate client-side), optional
  plan picker. `409 quota_exceeded` → show upgrade prompt with the message.

### 4.4 Instance detail — `/o/{org}/instances/{id}`

Tabs, each mapping to proxy routes (launcher payloads, see
[launcher-api.md](launcher-api.md) for shapes):

| Tab | Calls | Needs permission |
| --- | --- | --- |
| **Overview** | `GET …/gateway/status` (poll ~10 s) + Start/Stop/Restart buttons (`POST …/gateway/{start,stop,restart}`) | read: `instance:read` · buttons: `instance:lifecycle` |
| **Logs** | `GET …/gateway/logs?log_offset=&log_run_id=` (see §4.5) · Clear | `instance:logs:read` · clear: `instance:lifecycle` |
| **Config** | `GET …/config` → edit → `PATCH …/config` (JSON Merge Patch — send only changed keys) · Reset | `instance:config:read` / `instance:config:write` |
| **Models** | `GET …/models`, add/edit/delete/test, set default | `instance:models:read` / `instance:models:write` |
| **Channels** | `GET …/channels/catalog`, per-channel `GET …/channels/{name}/config`; WeChat/WeCom QR flows (§4.6) | `instance:channels:read` / `instance:channels:write` |
| **Sessions** | `GET …/sessions`, `GET …/sessions/{id}`, delete | `instance:sessions:read` / `instance:sessions:delete` |
| **Skills / Tools** | `GET …/skills`, search/install/import/delete · `GET …/tools`, toggle state | `instance:skills:*` / `instance:tools:*` |
| **Access** | role bindings list/edit (§4.7) | `org:members:read` / `org:members:manage` |
| **Danger zone** | Suspend/Resume, Delete | `instance:lifecycle` / `instance:delete` |

Notes:

- The launcher masks secrets itself (`api_key: "sk-****abcd"`, channel secrets
  reported by presence only) — render masked values as-is, never diff them
  back into a PUT. Empty/omitted secret fields on update mean "keep existing".
- `PATCH …/config` validation failures come back as the launcher's
  `400 {"status":"validation_error","errors":[…]}` — surface `errors` inline.
- `POST …/gateway/start` can return the launcher's
  `400 {"status":"precondition_failed","message":…}` (no default model
  configured, etc.) — show `message` and deep-link to the Models tab.

### 4.5 Log polling (incremental)

The launcher keeps a 200-line ring buffer. Poll incrementally:

```ts
let logOffset = 0, logRunId = 0;
async function pollLogs(instanceId: Uuid) {
  const r = await api<{ logs: string[]; log_total: number; log_run_id: number }>(
    `/v1/instances/${instanceId}/gateway/logs?log_offset=${logOffset}&log_run_id=${logRunId}`);
  if (r.log_run_id !== logRunId) clearViewer();   // buffer was reset
  appendLines(r.logs);
  logOffset = r.log_total;
  logRunId = r.log_run_id;
}
// setInterval(pollLogs, 2000) while the Logs tab is visible
```

### 4.6 QR login flows (WeChat / WeCom channels)

1. `POST …/weixin/flows` (or `wecom`) → `{flow_id, status:"wait", qr_data_uri}`.
   Render `qr_data_uri` directly in an `<img src>`.
2. Poll `GET …/weixin/flows/{flow_id}` every ~2 s.
   `status`: `wait` → `scaned` (show "confirm on phone") → `confirmed`
   (done — the launcher saved the credentials and restarted the gateway) or
   `expired`/`error` (offer retry). Flows expire after 5 minutes.

OAuth provider login (Models credentials) is the same pattern via
`POST …/oauth/login` + polling `GET …/oauth/flows/{id}`.

### 4.7 Members & access — `/o/{org}/settings/members`

- Members table: `GET /v1/orgs/{org_id}/members`; change role via `PATCH`,
  remove via `DELETE`. A `409` here means "last owner" — show the message.
- **Invite**: `POST /v1/orgs/{org_id}/invitations {email, role}` → response
  contains `token` **once**. Build the link yourself:
  `https://app.example.com/invite?token=<token>` and show it with a copy
  button (the API does not send email).
- **Per-instance access** (instance detail → Access tab): list
  `GET /v1/instances/{id}/role-bindings`; grant with
  `PUT …/role-bindings/{user_id} {role}`. Explain in the UI: *binding is
  additive — it raises this user's abilities on this instance only.*

### 4.8 Roles — `/o/{org}/settings/roles`

`GET /v1/orgs/{org_id}/roles` returns built-ins (`is_system: true`, immutable
— render locked) and custom roles. Custom role editor = name + description +
permission checklist grouped by prefix (`org:*`, `instance:*`). Use each
role's `permissions` array as the source of truth for the checklist state.

### 4.9 API keys — `/o/{org}/settings/api-keys`

- Create dialog: name, permission checklist (limit choices to the **current
  user's own permissions** — the API rejects anything broader with
  `400 invalid_permissions`), optional instance restriction, optional expiry.
- The `secret` is in the create response **only**. Show it once in a modal
  with copy-to-clipboard and a "you won't see this again" note.
- List shows `key_prefix` (e.g. `pck_Ed1ux5RU`), never the secret.
  Delete = revoke, immediate.

### 4.10 Audit log — `/o/{org}/settings/audit`

`GET /v1/orgs/{org_id}/audit-logs?limit=100` (+ `instance_id`, `action`
filters). Render `result: "denied"` rows distinctly — they answer "why can't
my teammate do X". Newest first, no pagination cursor yet — cap at the limit.

---

## 5. Permission-driven UI

Fetch once per org (and cache): `GET /v1/me` (role name per org) +
`GET /v1/orgs/{org_id}/roles` (role name → permission list). Derive:

```ts
function usePermissions(orgId: Uuid): Set<string> {
  const me = useMe();
  const roles = useRoles(orgId);              // GET /v1/orgs/{id}/roles
  const roleName = me.memberships.find(m => m.org_id === orgId)?.role;
  const perms = roles.find(r => r.name === roleName)?.permissions ?? [];
  return new Set(me.user.is_platform_admin ? ALL_PERMISSIONS : perms);
}

const can = (perms: Set<string>, p: string) => perms.has(p);
// <Button disabled={!can(perms, "instance:lifecycle")}>Restart</Button>
```

Caveats:

- **Instance-scoped bindings** can grant *more* on a specific instance than
  the org role shows. There is no "effective permissions" endpoint yet, so
  the reliable pattern is: gate primary navigation on org-role permissions,
  but treat a `403` on an instance action as the source of truth rather than
  pre-hiding everything (or fetch `GET /v1/instances/{id}/role-bindings` when
  you have `org:members:read` and merge).
- Hiding a button is UX, not security — the API enforces everything. Always
  handle `403` gracefully anyway (see §6).
- `GET /v1/orgs/{org_id}/roles` itself requires `org:roles:read` (viewer
  doesn't have it). Fall back to a bundled copy of the built-in role matrix
  ([design.md §3.3](design.md)) for role names you can't
  resolve via the API.

---

## 6. Error handling

Every API error (except 422 validation) has the shape
`{"error": {"code", "message"}}`:

```ts
async function toApiError(r: Response): Promise<Error & { code?: string }> {
  try {
    const body = await r.json();
    const e = new Error(body?.error?.message ?? r.statusText) as any;
    e.code = body?.error?.code; e.status = r.status;
    return e;
  } catch { return new Error(r.statusText); }
}
```

| status / code | Meaning | UI response |
| --- | --- | --- |
| `401 unauthorized` | Token invalid/expired | Refresh once, then logout. |
| `403 forbidden` | Missing permission (message names it) | Toast "You don't have permission: …"; don't retry. |
| `404 not_found` | Gone or never allowed (proxy allowlist) | Navigate away / show empty state. |
| `409 conflict` | State conflict (last owner, slug taken, instance not running, org has instances) | Show `message` inline near the action. |
| `409 quota_exceeded` | Plan cap | Upgrade prompt. |
| `400 invalid_*` | Bad input (role, permission, plan…) | Inline form error. |
| `422` | Schema validation (FastAPI format) | Map `detail[].loc` to form fields. |
| `502 / 503` | Instance launcher unreachable / not provisioned | "Instance unreachable" banner + retry; check `status` isn't `provisioning`/`suspended`. |
| Launcher-shaped errors | e.g. `{"status":"validation_error"}`, `{"error":"…"}` from proxied routes | Handle per §4.4 notes. |

---

## 7. Gotchas checklist

- [ ] Refresh tokens rotate — always store the new one; serialize refreshes.
- [ ] Invitation `token` and API-key `secret` are shown **exactly once**.
- [ ] Instance actions 409 until the deployment layer flips status to
      `running` — in the current build nothing does this automatically, so
      dev/test environments must set it manually (see backend team).
- [ ] Proxy responses are launcher-shaped, not control-plane-shaped — two
      error formats on instance pages.
- [ ] `PATCH /v1/instances/{id}/config` is a JSON **Merge Patch**: send only
      what changed; `null` deletes a key.
- [ ] Don't echo masked secrets (`sk-****…`) back in config/model updates.
- [ ] Slugs are immutable after creation (no rename endpoint) — set
      expectations in the create dialog.
- [ ] `expires_in` is seconds; schedule proactive refresh at ~80% of it to
      avoid a 401 round-trip.
- [ ] No WebSocket console yet (`/pico/ws` bridging is not implemented) —
      don't build the chat/console tab against it until the backend ships it.
- [ ] CORS: coordinate the dashboard origin with the backend (no CORS
      middleware is configured yet in the API).
