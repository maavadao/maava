# mawa core HTTP API Reference

> OpenAPI-style reference for the two HTTP services shipped with the mawa core
> launcher image. The launcher binary (`picoclaw-launcher`) embeds the Vue
> dashboard and proxies browser traffic to a managed `picoclaw gateway`
> subprocess.

| Service | Process | Default listen | Default port | Purpose |
| --- | --- | --- | --- | --- |
| **Launcher API** | `picoclaw-launcher` | loopback (`127.0.0.1`) — overridden by `-public`/`-host` or `CORE_LAUNCHER_HOST` | **18800** | Web dashboard, config CRUD, model catalog, OAuth login flows, gateway lifecycle control, session history, skill management |
| **Gateway API** | `picoclaw gateway` | loopback (`127.0.0.1`) — overridden by `gateway.host` or `CORE_GATEWAY_HOST` | **18790** | Shared webhook receiver, channel runtime health, runtime events, config hot-reload, managed child of the launcher |

The Docker compose file maps both ports to the host (`18800:18800`, `18790:18790`)
and overrides the gateway host to `0.0.0.0` so reverse proxies / webhooks can
reach it.

> Source of truth: `web/backend/api/*.go`, `web/backend/main.go`,
> `web/backend/middleware/launcher_dashboard_auth.go`,
> `web/backend/launcherconfig/config.go`, `pkg/gateway/gateway.go`,
> `pkg/health/server.go`, `pkg/channels/manager.go`, `pkg/channels/line/line.go`,
> `pkg/channels/pico/pico.go`.

---

## 1. Launcher API (`http://localhost:18800`)

### 1.1 Common conventions

- **Base path:** all endpoints are mounted directly (no `/api/v1` prefix).
- **Auth model:** an HttpOnly session cookie plus a dashboard password. Every
  request that is not in the public list is rejected by the
  `LauncherDashboardAuth` middleware.
- **Content type:** requests must send `Content-Type: application/json` for any
  body. Responses are `application/json` (set by `JSONContentType` middleware).
- **CORS / origin:** cross-site setup requests are explicitly rejected
  (`Sec-Fetch-Site: cross-site` or mismatched `Origin` / `Referer` returns
  `403 cross-site setup request rejected`).
- **CSRF:** the dashboard relies on the `SameSite=Lax` cookie plus the
  same-origin check above. There is no separate CSRF token header.
- **Error envelope:** `{"error": "<message>"}` with a `4xx` / `5xx` status. The
  `/api/config` PUT/PATCH handlers use `{"status":"validation_error","errors":[...]}`.
- **Loopback bypass:** when the launcher binds to loopback and the password
  store is initialized, a one-shot auto-login grant is exposed at
  `/launcher-auto-login?nonce=…` for 5 minutes — used by the bundled browser
  auto-open flow. Successful consumption sets the session cookie and redirects
  to `/`.

#### Public paths (no session required)

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Body `{"password":"…"}`. Sets `picoclaw_launcher_auth` cookie. |
| `POST` | `/api/auth/logout` | Body must be `{}` with `Content-Type: application/json`. |
| `GET`  | `/api/auth/status` | Returns `{"authenticated":bool,"initialized":bool}`. |
| `POST` | `/api/auth/setup` | First-run password creation. Cross-site requests blocked. After init, requires an existing session (change-password flow). |
| `GET`/`HEAD` | `/launcher-login`, `/launcher-setup` | SPA routes served by the embedded frontend. |
| `GET`/`HEAD` | `/assets/…`, `/favicon.ico`, `/favicon.svg`, `/favicon-96x96.png`, `/apple-touch-icon.png`, `/site.webmanifest`, `/robots.txt` | Embedded static assets. |
| `GET`/`HEAD` | `/` (any other non-API path) | SPA fallback to `index.html`. Missing assets return 404. |
| `GET`/`HEAD` | `/launcher-auto-login?nonce=…` | One-shot grant. Sets cookie + 303 → `/`. |

> Everything else requires the session cookie. API responses return
> `401 {"error":"unauthorized"}`; HTML routes redirect to `/launcher-login`
> (302). `/pico/ws` always returns `401 unauthorized` so WS clients re-auth
> through the SPA.

### 1.2 Auth endpoints

| Method | Path | Body | Response | Notes |
| --- | --- | --- | --- | --- |
| `POST` | `/api/auth/login` | `{"password":"…"}` | `200 {"status":"ok"}` / `401 {"error":"invalid password"}` / `409 password has not been set` / `429 too many login attempts` | Rate-limited per source IP. Sets `picoclaw_launcher_auth` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` when `r.TLS` or `X-Forwarded-Proto=https`, 31-day `MaxAge`). |
| `POST` | `/api/auth/logout` | empty JSON body | `200 {"status":"ok"}` / `415 / 400` | Clears the session cookie. |
| `GET`  | `/api/auth/status` | – | `200 {"authenticated":bool,"initialized":bool}` | Used to decide whether to show login vs setup page. |
| `POST` | `/api/auth/setup` | `{"password":"…","confirm":"…"}` | `200 {"status":"ok"}` / `400 password must not be empty` / `400 passwords do not match` / `400 password must be at least 8 characters` / `401 must be authenticated to change password` / `403 cross-site setup request rejected` / `503 password store unavailable` | First-run when store is uninitialized requires no session. After init, requires an active session (password change). |

Source: [web/backend/api/auth.go](web/backend/api/auth.go), [web/backend/middleware/launcher_dashboard_auth.go](web/backend/middleware/launcher_dashboard_auth.go).

### 1.3 System

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET`  | `/api/system/version` | – | `200 {"version","git_commit","build_time","go_version"}` (resolved from `picoclaw --version` if available, else launcher ldflags). |
| `GET`  | `/api/system/launcher-config` | – | `200 {"port","public","allowed_cidrs","allow_localhost_bypass","trusted_proxy_cidrs"}` |
| `PUT`  | `/api/system/launcher-config` | full payload (see response) | `200` (same envelope) / `400` on validation |
| `GET`  | `/api/system/autostart` | – | `200 {"enabled","supported","platform","message"}` |
| `PUT`  | `/api/system/autostart` | `{"enabled":bool}` | `200` (same envelope) / `400 autostart is not supported on this platform` |
| `POST` | `/api/update` | `{"url":"…","binary":"picoclaw-launcher"}` | `200 {"status":"ok","message":"update applied; restart to use new version"}` / `405 / 400 / 500` |

`/api/system/launcher-config` round-trips the launcher's persistent settings
(`port`, `public`, `allowed_cidrs`, `allow_localhost_bypass`,
`trusted_proxy_cidrs`). It is loaded from and saved to
`launcherconfig.PathForAppConfig(configPath)`.

`/api/update` shells out to the bundled `pkg/updater` to download and replace
the launcher binary in place; restart is required.

Sources: [web/backend/api/version.go](web/backend/api/version.go), [web/backend/api/launcher_config.go](web/backend/api/launcher_config.go), [web/backend/api/startup.go](web/backend/api/startup.go), [web/backend/api/update.go](web/backend/api/update.go).

### 1.4 Config CRUD

All three are guarded by `validateConfig` and require an existing or
post-patch valid model + `channels.{pico,telegram,discord,wecom,qq,weixin,feishu,dingtalk,line,slack,onebot,matrix,whatsapp,whatsapp_native,maixcam,irc,mqtt}` entries (the set is enforced by
`config.ValidateModelList` and `config.ValidateTurnProfile`). Secret fields
(tokens, API keys) are preserved across round-trips via
`SecurityCopyFrom` + `applyConfigSecretsFromMap`.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET`  | `/api/config` | – | `200` full `config.Config` JSON (gateway token masked in lists, secrets omitted). |
| `PUT`  | `/api/config` | full `config.Config` JSON | `200 {"status":"ok"}` / `400 validation_error` / `500` |
| `PATCH`| `/api/config` | RFC 7396 JSON Merge Patch | `200 {"status":"ok"}` / `400` / `500` |
| `POST` | `/api/config/reset` | – | `200 {"status":"ok"}` — preserves API keys/secrets. Restarts the gateway if it was running. |
| `POST` | `/api/config/test-command-patterns` | `{"allow_patterns":[...],"deny_patterns":[...],"command":"…"}` | `200 {"allowed":bool,"blocked":bool,"matched_whitelist":string?,"matched_blacklist":string?}` |

Sources: [web/backend/api/config.go](web/backend/api/config.go).

### 1.5 Models

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET`  | `/api/models` | – | `200 {"models":[…],"total":N,"default_model":"…","provider_options":[…]}` — each `modelResponse` exposes the full `config.ModelConfig` plus `is_default`, `is_virtual`, `available`, `status`, `default_model_allowed`, and a **masked** `api_key` (e.g. `sk-****abcd`). |
| `POST` | `/api/models/fetch` | `{"provider":"openai","api_key":"…","api_base":"…","model_index":int?}` | `200 {"models":[{"id","owned_by"}],"total":N}` — probes the upstream `/v1/models` (or `/api/tags` for Ollama, `/model/list` for `nearai`). |
| `GET`  | `/api/models/catalog` | – | `200 {"catalogs":[…]}` — saved provider catalogs (see `model_catalog.go`). |
| `DELETE` | `/api/models/catalog/{id}` | – | `200 {"status":"ok"}` / `404` |
| `POST` | `/api/models` | `config.ModelConfig` + top-level `"api_key":"…"` | `200 {"status":"ok","index":N}` / `400 validation error` |
| `POST` | `/api/models/default` | `{"model_name":"…"}` | `200 {"status":"ok","default_model":"…"}` / `400 / 404` — refuses virtual models and providers that can't be default chat providers. |
| `PUT`  | `/api/models/{index}` | same as POST | `200 {"status":"ok"}` / `400 / 404` — preserves existing `api_key` when omitted, preserves `extra_body`/`custom_headers` when omitted, can clear them by sending `{}`. |
| `DELETE` | `/api/models/{index}` | – | `200 {"status":"ok"}` / `404` — clears `agents.defaults.model_name` if it was the default. |
| `POST` | `/api/models/{index}/test` | – | `200 {"status":"ok",…}` (probes credentials). |
| `POST` | `/api/models/test-inline` | `config.ModelConfig` | `200 {"status":"ok",…}` |

`POST /api/models/fetch` auto-saves the returned IDs to the per-provider
catalog; passing `model_index` reuses the stored API key when `api_key` is
empty. Errors from the upstream are mapped to `502`.

Sources: [web/backend/api/models.go](web/backend/api/models.go), [web/backend/api/model_catalog.go](web/backend/api/model_catalog.go), [web/backend/api/model_status.go](web/backend/api/model_status.go).

### 1.6 Channels

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET`  | `/api/channels/catalog` | – | `200 {"channels":[{"name","config_key","variant?"}, …]}` — fixed catalog of `weixin`, `telegram`, `discord`, `slack`, `feishu`, `dingtalk`, `line`, `qq`, `onebot`, `wecom`, `whatsapp` (variant `bridge`), `whatsapp_native` (variant `native`), `pico`, `maixcam`, `matrix`, `irc`, `mqtt`. |
| `GET`  | `/api/channels/{name}/config` | – | `200 channelConfigResponse` (`config` map with secrets stripped, `configured_secrets` list, `config_key`, `variant`). Returns `404` for unknown names. |

Secret-field metadata is defined in `channelSecretFieldMap` (e.g. `telegram`
→ `token`, `discord` → `token`, `wecom` → `secret`, etc.); the response only
**reports presence** — it does not echo the secret value.

Sources: [web/backend/api/channels.go](web/backend/api/channels.go).

### 1.7 Sessions

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET`  | `/api/sessions` | – | `200 {"sessions":[{id,title,preview,message_count,created,updated}]}` — read from `~/.picoclaw/sessions/` and from legacy Pico session JSON/JSONL files (`agent:main:pico:direct:pico:<uuid>`). |
| `GET`  | `/api/sessions/{id}` | – | `200 {"id","title","created","updated","messages":[{role,content,kind,model_name,created_at,media,attachments,tool_calls}, …]}` |
| `DELETE` | `/api/sessions/{id}` | – | `200 {"status":"ok"}` |

Source: [web/backend/api/session.go](web/backend/api/session.go).

### 1.8 Skills

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET`  | `/api/skills` | – | `200 {"skills":[{name,path,source,description,origin_kind,registry_name?,registry_url?,installed_version?,installed_at?}]}` |
| `GET`  | `/api/skills/{name}` | – | `200 {…same as above plus "content":"…"}` / `404` |
| `GET`  | `/api/skills/search?q=…&limit=20&offset=0` | – | `200 {"results":[{score,slug,display_name,summary,version,registry_name,url?,installed,installed_name?}], "limit","offset","next_offset"?,"has_more"}` — requires `tools.find_skills` enabled, otherwise `400`. |
| `POST` | `/api/skills/install` | `{"slug":"…","registry":"github","version?":"…","force?":bool}` | `200 installSkillResponse` — requires `tools.install_skill` enabled. |
| `POST` | `/api/skills/import` | `multipart/form-data` (≤ 1 MiB) | `200 skillSupportItem` / `413 / 400` — uploads a workspace skill bundle. |
| `DELETE` | `/api/skills/{name}` | – | `200 {"status":"ok"}` |

Searches upstream registries (`github`, …). `limit` must be `1..50`,
`offset` must be `>= 0`.

Source: [web/backend/api/skills.go](web/backend/api/skills.go).

### 1.9 Tools

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET`  | `/api/tools` | – | `200 {"tools":[{name,description,category,config_key,status,reason_code?}, …]}` — status ∈ `enabled`, `disabled`, `blocked`; `reason_code` ∈ `requires_skills`, `requires_subagent`, `requires_linux`. |
| `PUT`  | `/api/tools/{name}/state` | `{"enabled":bool}` | `200 {"status":"ok"}` / `400` |
| `GET`  | `/api/tools/web-search-config` | – | `200 webSearchConfigResponse` (provider, current_service, prefer_native, proxy, providers[], settings{}) |
| `PUT`  | `/api/tools/web-search-config` | `webSearchConfigRequest` | `200 webSearchConfigResponse` |

`PUT /api/tools/{name}/state` enables/disables the named tool. The body is
identical for every tool; `name` is the `name` field from the catalog (e.g.
`web_search`, `cron`, `exec`, `mcp_discovery`, etc.).

Source: [web/backend/api/tools.go](web/backend/api/tools.go).

### 1.10 OAuth

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET`  | `/api/oauth/providers` | – | `200 {"providers":[{provider,display_name,methods[],status,logged_in,auth_method?,expires_at?,account_id?,email?,project_id?}]}` — `status` ∈ `not_logged_in`, `connected`, `needs_refresh`, `expired`. |
| `POST` | `/api/oauth/login` | `{"provider":"openai","method":"browser"\|"device_code"\|"token","token":"…"}` | For `token`: `200 {"status":"ok","provider","method"}`. For `device_code`: `200 {"status":"ok","provider","method","flow_id","user_code","verify_url","interval","expires_at"}`. For `browser`: same envelope with PKCE state stored under the returned `flow_id`. |
| `GET`  | `/api/oauth/flows/{id}` | – | `200 oauthFlowResponse` — poll this until `status` is `connected` / `expired` / `error`. |
| `POST` | `/api/oauth/flows/{id}/poll` | – | `200 oauthFlowResponse` — explicit poll endpoint (browser flows exchange the auth code here). |
| `POST` | `/api/oauth/logout` | – | `200 {"status":"ok"}` |
| `GET`  | `/oauth/callback` | – | Browser redirect target for the `browser` flow. `code` / `state` query params; completes the flow and redirects. |

Providers and methods are listed in `oauthProviderOrder` and
`oauthProviderMethods` (e.g. `openai` → `token`/`device_code`/`browser`;
`claude` → `token`; `antigravity` → `oauth`/token).

Source: [web/backend/api/oauth.go](web/backend/api/oauth.go).

### 1.11 WeChat & WeCom QR login

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `POST` | `/api/weixin/flows` | – | `200 weixinFlowResponse` (`flow_id`, `status="wait"`, `qr_data_uri` data-URI PNG). TTL 5 min. |
| `GET`  | `/api/weixin/flows/{id}` | – | `200 weixinFlowResponse` — `status` ∈ `wait`, `scaned`, `confirmed`, `expired`, `error`. On `confirmed`, the bot token + `ilink_bot_id` are saved into `channels.weixin` and the gateway is restarted if it was running. |
| `POST` | `/api/wecom/flows` | – | `200 wecomFlowResponse` (`flow_id`, `status="wait"`, `qr_data_uri`). TTL 5 min. |
| `GET`  | `/api/wecom/flows/{id}` | – | `200 wecomFlowResponse` — `status` ∈ `wait`, `scaned`, `confirmed`, `expired`, `error`. On `confirmed`, the `bot_id` + `secret` are saved into `channels.wecom` and the gateway is restarted if it was running. |

Sources: [web/backend/api/weixin.go](web/backend/api/weixin.go), [web/backend/api/wecom.go](web/backend/api/wecom.go).

### 1.12 Gateway lifecycle (managed subprocess)

The launcher starts the gateway as a child process (`picoclaw gateway -E`) and
probes its `/health` endpoint to confirm liveness. It also reads the gateway's
`pidfile` (token + port + host) so it can attach to a gateway that was already
running before the launcher started.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET`  | `/api/gateway/status` | – | `200 {gateway_status, pid?, gateway_version?, boot_default_model?, config_default_model?, gateway_restart_required, gateway_start_allowed, gateway_start_reason?}` — `gateway_status` ∈ `stopped`, `starting`, `running`, `restarting`, `error`. |
| `GET`  | `/api/gateway/logs?log_offset=N&log_run_id=M` | – | `200 {"logs":[string],"log_total":N,"log_run_id":M}` — ring buffer (200 lines) of stdout+stderr captured by the launcher; pass back the previous `log_total` / `log_run_id` for incremental reads. `log_run_id` increments whenever the buffer is reset. |
| `POST` | `/api/gateway/logs/clear` | – | `200 {"status":"cleared","log_total":0,"log_run_id":N}` |
| `POST` | `/api/gateway/start` | – | `200 {"status":"ok","pid":N}` / `400 {"status":"precondition_failed","message":"…"}` — refuses to start without a configured default model or reachable credentials. |
| `POST` | `/api/gateway/stop` | – | `200 {"status":"ok","pid":N}` or `{"status":"not_running"}` / `500` — `SIGTERM`, then `SIGKILL` after 3 s. |
| `POST` | `/api/gateway/restart` | – | `200 {"status":"ok","pid":N}` / `400 precondition_failed` / `500` |

The launcher auto-starts the gateway ~1 s after its own listener is up; the
`TryAutoStartGateway` goroutine reuses an existing PID-file gateway when
`gatewayStartReady` returns true.

Source: [web/backend/api/gateway.go](web/backend/api/gateway.go).

### 1.13 Pico channel (browser)

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET`  | `/api/pico/info` | – | `200 {"ws_url","enabled","configured"}` (no secrets). |
| `POST` | `/api/pico/setup` | – | `200 {same}` — idempotent: enables the Pico channel and generates a token if none exists. |
| `POST` | `/api/pico/token` | – | `200 {same}` — rotates the WebSocket token in-place. |
| `GET`  | `/pico/ws` (WebSocket upgrade) | – | `101` reverse-proxied to the gateway's `/pico/ws`. `401` when no session cookie. The launcher injects the raw Pico token via the `Sec-Websocket-Protocol: token.<pico-token>` header on the upstream request. |
| `GET`/`HEAD` | `/pico/media/{id}` | – | `200` proxied to the gateway, `Authorization: Bearer <pico-token>` injected. `503` when gateway is down, `403` when token is missing. |

`buildPicoEventsURL` and `buildPicoSendURL` are URL builders used in
`/api/pico/info` responses. They produce paths `/pico/events` and
`/pico/send` for documentation / reserved-URL purposes — the registered
launcher routes are limited to `/pico/ws` and `/pico/media/{id}`; clients
should consume the WebSocket connection returned via `/pico/ws` for the
event stream and POST replies through the WebSocket itself.

Source: [web/backend/api/pico.go](web/backend/api/pico.go), [web/backend/api/gateway_host.go](web/backend/api/gateway_host.go).

### 1.14 Frontend / static

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET`/`HEAD` | `/` (and any other non-API, non-asset path) | – | `200` SPA `index.html` (Vue dashboard), served by the embedded `web/frontend/dist`. Asset-like paths (containing a `.`) fall through to `http.FileServer`; if missing they 404 instead of falling back to `index.html`. |
| `GET`/`HEAD` | `/assets/…` | – | Static assets (with `Cache-Control: max-age=31536000, immutable` set by Vite). |
| `GET`  | any other non-API path | – | Same SPA fallback. |

Source: [web/backend/embed.go](web/backend/embed.go).

---

## 2. Gateway API (`http://localhost:18790`)

The gateway binary is the actual runtime: it loads the config, instantiates
the LLM provider, the agent loop, the cron service, the heartbeat, the
media store, and the channel manager. The shared HTTP server is created by
the channel manager at `pkg/channels/manager.go::SetupHTTPServerListeners` and
shares its `mux` between the health endpoints and any channels that
implement `WebhookHandler` (currently `LINEChannel` and `PicoChannel`).

| Endpoint | Bound to | Method | Description |
| --- | --- | --- | --- |
| `/health` | health server | `GET` | Liveness probe. Returns `200 {"status":"ok","uptime":"…","pid":N,"checks":{name:{name,status,message?,timestamp}}}` with `5 s` timeouts. Used by `Dockerfile.launcher` `HEALTHCHECK` (`wget --spider http://localhost:18790/health`). |
| `/ready`  | health server | `GET` | Readiness probe. Returns `200` once the gateway has flipped `HealthServer.SetReady(true)` (after services are up) along with all registered `Check` entries; otherwise `503 {"status":"not ready",…}`. |
| `/reload` | health server | `POST` | Manual config hot-reload. Body ignored. Requires `Authorization: Bearer <pidfile-token>` when the gateway was started with a PID-file token. Returns `200 {"status":"reload triggered"}` / `401 unauthorized` / `405 method not allowed` / `500 {error}` / `503 {"error":"reload not configured"}`. |
| `/webhook/line` | `LINEChannel.ServeHTTP` | `POST` | LINE Messaging API webhook. Validates HMAC signature via `line-bot-sdk-go` using `channel_secret`. Body limit 1 MiB (oversize → `413`). Invalid signature → `403`. Other parse failures → `400`. On success returns `200` immediately and processes events in goroutines. Configurable via `channels.line.webhook_path`. |
| `/pico/` (and sub-paths) | `PicoChannel.ServeHTTP` | `GET` (WebSocket) / `GET` (binary) | Pico protocol. `/pico/ws` upgrades a WebSocket and authenticates via the `token.<pico-token>` subprotocol (`Sec-Websocket-Protocol`). `/pico/media/{id}` serves cached media by ID; `404` for unknown IDs. |

> All other channels (Telegram, Discord, Slack, Feishu, DingTalk, WeCom, QQ,
> OneBot, WhatsApp, WhatsApp-Native, Matrix, IRC, MQTT, MaixCam) do **not**
> bind HTTP routes here. They use long-polling, WebSocket, MQTT, or vendor
> SDKs (Feishu / DingTalk / WeCom / Discord / Telegram are SDK-based; Matrix
> uses its client API; IRC/MQTT use their own transports).

The gateway also writes a PID file (`picoclaw.pid.json`) at startup with the
structure:

```jsonc
{
  "pid": 12345,
  "host": "127.0.0.1",
  "port": 18790,
  "token": "random-base64-url-token",  // required for /reload
  "version": "v…",
  "started_at": "2026-07-24T10:00:00Z"
}
```

Sources: [pkg/gateway/gateway.go](pkg/gateway/gateway.go), [pkg/health/server.go](pkg/health/server.go), [pkg/channels/manager.go](pkg/channels/manager.go), [pkg/channels/line/line.go](pkg/channels/line/line.go), [pkg/channels/pico/pico.go](pkg/channels/pico/pico.go), [pkg/pid/pidfile.go](pkg/pid/pidfile.go).

### 2.1 Hot-reload behavior

- The gateway polls `config.json` on a 1 s interval when `gateway.hot_reload`
  is `true` (configurable in `config.Gateway.HotReload`).
- External triggers: `POST /reload` (with bearer token) or sending `SIGHUP`
  via the launcher's `gatewayRestartRequiredBySignature` change-detection.
- During reload, `reloading` is set so concurrent triggers are coalesced and
  `runtimeevents.KindGatewayReload{Started,Completed,Failed}` events are
  published.

### 2.2 Channel webhook signatures

| Channel | Transport | Endpoint on gateway | Auth | Body limit |
| --- | --- | --- | --- | --- |
| **LINE** | HTTP webhook | `POST /webhook/line` (configurable) | `X-Line-Signature` HMAC-SHA256 of body with `channel_secret` | 1 MiB |
| **Pico** | WebSocket | `GET /pico/ws` | `Sec-Websocket-Protocol: token.<pico-token>` | n/a |
| **Pico** | HTTP | `GET /pico/media/{id}` | `Authorization: Bearer <pico-token>` (launcher injects) | n/a |
| **Telegram** | long-poll | – | – | – |
| **Discord** | Gateway WebSocket | – | – | – |
| **Slack** | Socket Mode / Events API | – | – | – |
| **Feishu** | SDK WebSocket | – | – | – |
| **DingTalk** | SDK stream | – | – | – |
| **WeCom** | SDK WebSocket | – | – | – |
| **QQ** | SDK | – | – | – |
| **OneBot** | HTTP reverse / WebSocket | – | – | – |
| **Matrix** | Client-Server API | – | – | – |
| **WhatsApp** | bridge (external) | – | – | – |
| **WhatsApp-Native** | `whatsmeow` socket | – | – | – |
| **IRC** | TCP | – | – | – |
| **MQTT** | broker | – | – | – |
| **MaixCam** | device SDK | – | – | – |

### 2.3 Static event surface

- `runtimeevents.KindGatewayStart` / `KindGatewayReady` /
  `KindGatewayReloadStarted` / `KindGatewayReloadCompleted` /
  `KindGatewayReloadFailed` are published on the gateway's runtime-event bus
  (consumed by the embedded dashboard, the agent loop, and any subscribed
  channel). They are **not** exposed as HTTP endpoints.

---

## 3. End-to-end flow examples

### 3.1 First-time dashboard setup

```text
browser                     launcher (18800)                password store
   │ GET  /                       │                                │
   │  ──────────────────────────► │ needsInitialSetup=true          │
   │  200 index.html              │                                │
   │                              │                                │
   │ GET  /api/auth/status        │                                │
   │  ──────────────────────────► │ check store.IsInitialized()    │
   │ 200 {"initialized":false}    │                                │
   │                              │                                │
   │ POST /api/auth/setup         │                                │
   │ {"password":"…","confirm":"…"}│                                │
   │  ──────────────────────────► │ store.SetPassword(hash)        │
   │ 200 {"status":"ok"}          │                                │
   │ Set-Cookie: picoclaw_launcher_auth=…                          │
   │                              │                                │
   │ GET  /api/config             │ (now authenticated)            │
   │  ──────────────────────────► │ config.LoadConfig              │
   │ 200 {…config…}               │                                │
```

### 3.2 Launching the gateway

```text
dashboard           launcher (18800)             picoclaw gateway (18790)
   │ POST /api/gateway/start         │                                 │
   │  ──────────────────────────────►│ gatewayStartReady()             │
   │                                 │ exec picoclaw gateway -E        │
   │                                 │ wait for pidfile + /health OK   │
   │ 200 {"status":"ok","pid":N}     │                                 │
   │                                 │                                 │
   │                                 │ ◄──── GET /health 200 ──────────│
   │                                 │                                 │
   │ GET  /api/gateway/logs?log_offset=0&log_run_id=1                │
   │  ──────────────────────────────►│ ring buffer scan                │
   │ 200 {"logs":[…],"log_total":N,"log_run_id":1}                   │
   │                                 │                                 │
   │ POST /api/gateway/reload        │                                 │
   │  ──────────────────────────────►│                                 │
   │                                 │ manualReloadChan <- struct{}{}  │
   │ 200 {"status":"ok"}             │ executeReload()                 │
   │                                 │   └► HTTP POST /reload          │
   │                                 │       Authorization: Bearer <t> │
   │                                 │       200 {"status":"reload triggered"}
```

### 3.3 Webhook flow (LINE)

```text
LINE servers            gateway (18790)            bus            agent loop
   │ POST /webhook/line       │                                  │
   │ X-Line-Signature: …      │                                  │
   │  ──────────────────────► │ verify HMAC, parse               │
   │                          │ dispatch into bus.InboundMessage  │
   │ 200 OK                   │  ───────────────────────────────►│
   │                          │                                  │ agent loop →
   │                          │                                  │ channels[id].Send
   │                          │ ◄──────────── outbound ───────────│
```

---

## 4. Quick reference card

### Launcher (18800)

```text
POST /api/auth/{login,logout,setup}        GET /api/auth/status
GET/PUT /api/system/{version,launcher-config,autostart}
GET/PUT/PATCH /api/config
POST /api/config/{reset,test-command-patterns}
GET/POST/PUT/DELETE /api/models[/{index}|/default|/fetch|/test|/catalog[/{id}]]
GET /api/channels/catalog, GET /api/channels/{name}/config
GET/DELETE /api/sessions[/{id}]
GET/POST/DELETE /api/skills[/{name}|/search|/install|/import]
GET/PUT /api/tools[/{name}/state], GET/PUT /api/tools/web-search-config
GET/POST /api/oauth/{providers,login,logout,flows[/{id}[/poll]]}
GET /oauth/callback
POST/GET /api/{weixin,wecom}/flows[/{id}]
GET/POST /api/gateway/{status,start,stop,restart,logs,logs/clear}
GET/POST /api/pico/{info,setup,token}
GET /pico/ws, GET|HEAD /pico/media/{id}
GET /assets/…, GET /
```

### Gateway (18790)

```text
GET  /health
GET  /ready
POST /reload                     Authorization: Bearer <pidfile-token>
POST /webhook/line               X-Line-Signature: HMAC-SHA256
GET  /pico/ws                    Sec-Websocket-Protocol: token.<pico-token>
GET  /pico/media/{id}            Authorization: Bearer <pico-token>
```
