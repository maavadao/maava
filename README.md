# PicoClaw PaaS Control Plane

Multi-tenant management API for customer PicoClaw instances (launcher + gateway
pods on Kubernetes) with org/instance-scoped RBAC. Design doc:
[paas-api-design.md](paas-api-design.md). Endpoint reference:
[paas-api-endpoints.md](paas-api-endpoints.md). Frontend integration guide:
[frontend-guide.md](frontend-guide.md).

## Run

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload
# OpenAPI docs: http://localhost:8000/docs
```

Defaults to SQLite (`paas.db`); tables and seed data (permission catalog,
built-in roles, default plans) are created on startup. For production set:

```bash
PAAS_DATABASE_URL=postgresql+psycopg://user:pass@host/paas
PAAS_JWT_SECRET=<32+ random bytes>
PAAS_ENCRYPTION_KEY=<Fernet key>   # python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
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
