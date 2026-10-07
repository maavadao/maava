# mawadao-agent-deployer

Provisions each member's hosted agent. It creates a Cloud Run service from
[`templates/cloud-run-service.yaml`](templates/cloud-run-service.yaml) running the
`mawadao-agent-gateway` image, then sets up the member's storage.

Part of [mawaDao Agent](https://github.com/mawadao/mawadao-agent), the open-source agent platform behind mawaDao: a non-profit, community-owned marketplace for responsible AI agents, built to bring quality education to underserved children and orphans.

## Endpoints

Routes are under `/api/v1` and need the `DEPLOYER_API_SECRET` bearer token.

| Path | Purpose |
| --- | --- |
| `/cloud-run` | Deploy, update and delete Cloud Run services |
| `/tenants` | Provision a member end to end: service and storage (`mawadao-agent-storage`) |
| `/healthz` | Health check |

## Run it locally

Requires Node.js 22 and Google Cloud credentials (`GOOGLE_CREDENTIALS_JSON` or application default credentials).

```bash
cp .env.example .env
npm ci
npm run dev        # http://localhost:3002
```

## Configuration

See [`.env.example`](.env.example). `CLOUD_BACKEND_IMAGE` defaults to
`ghcr.io/mawadao/mawadao-agent-gateway:latest`. `MEMBER_SPACE_URL` (default
`https://agent.mawadao.com`) is allowed as an origin on every member's runtime.

## Contributing

Read the [contributing guide](https://github.com/mawadao/mawadao-agent/blob/main/CONTRIBUTING.md) before opening a pull request.
This service lives in the `mawadao-agent` repository; pull requests go there. Releases are tagged
`deployer-vX.Y.Z` as described in [RELEASING.md](https://github.com/mawadao/mawadao-agent/blob/main/RELEASING.md).

## Licence

Apache 2.0. See [LICENSE](../../LICENSE).
