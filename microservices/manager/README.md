# mawadao-agent-manager

Control plane for hosted [`mawadao-agent-core`](https://github.com/mawadao/mawadao-agent-core)
instances (mawaDao Agent core launcher + gateway pods on Kubernetes), with org- and instance-scoped
roles, API keys and an audit log. Design doc: [docs/design.md](docs/design.md).
Endpoint reference: [docs/endpoints.md](docs/endpoints.md). Frontend
integration guide: [docs/frontend-guide.md](docs/frontend-guide.md). Launcher API:
[docs/launcher-api.md](docs/launcher-api.md).

Part of [mawaDao Agent](https://github.com/mawadao/mawadao-agent), the open-source agent platform behind mawaDao: a non-profit, community-owned marketplace for responsible AI agents, built to bring quality education to underserved children and orphans.

## Run

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload
# OpenAPI docs: http://localhost:8000/docs
```

Defaults to SQLite (`paas.db`); tables and seed data (permission catalog,
built-in roles, default plans) are created on startup. For production set:

```bash
MANAGER_DATABASE_URL=postgresql+psycopg://user:pass@host/paas
MANAGER_JWT_SECRET=<32+ random bytes>
MANAGER_ENCRYPTION_KEY=<Fernet key>   # python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

## Layout

| File | Purpose |
| --- | --- |
| [app/models.py](app/models.py) | Full schema incl. reserved K8s deployment tables |
| [app/rbac.py](app/rbac.py) | Permission catalog, built-in roles, resolver, `require()` dependency |
| [app/security.py](app/security.py) | bcrypt, JWT, API keys, Fernet encryption at rest |
| [app/routers/auth.py](app/routers/auth.py) | Register / login / refresh / me |
| [app/routers/orgs.py](app/routers/orgs.py) | Orgs, members, invitations, audit log |
| [app/routers/roles.py](app/routers/roles.py) | Built-in + custom roles |
| [app/routers/api_keys.py](app/routers/api_keys.py) | Org API keys (narrowing only) |
| [app/routers/instances.py](app/routers/instances.py) | Instance CRUD, lifecycle, role bindings |
| [app/routers/proxy.py](app/routers/proxy.py) | RBAC-gated proxy → instance launcher API |
| [app/proxy_client.py](app/proxy_client.py) | Launcher session management (platform-held password) |
| [app/seed.py](app/seed.py) | Idempotent seed of permissions/roles/plans |

## Quick tour

```bash
# register + first org (returns tokens)
curl -X POST localhost:8000/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"me@acme.com","password":"password123","org_name":"Acme"}'

# create an instance (org id from GET /v1/me)
curl -X POST localhost:8000/v1/orgs/$ORG/instances \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Support Bot","slug":"support-bot"}'

# proxied launcher call, RBAC-checked (requires instance:read)
curl localhost:8000/v1/instances/$INSTANCE/gateway/status \
  -H "Authorization: Bearer $TOKEN"
```

Deployment/provisioning (the reconciler that turns `instances` rows into K8s
workloads and flips them to `running`) is intentionally not implemented yet —
the `clusters` / `releases` / `instance_deployments` / `deployment_operations`
tables are already in place for it.

## Contributing

Read the [contributing guide](https://github.com/mawadao/mawadao-agent/blob/main/CONTRIBUTING.md) before opening a pull request.
This service lives in the `mawadao-agent` repository; pull requests go there. Releases are tagged
`manager-vX.Y.Z` as described in [RELEASING.md](https://github.com/mawadao/mawadao-agent/blob/main/RELEASING.md).

## Licence

Apache 2.0. See [LICENSE](../../LICENSE).
