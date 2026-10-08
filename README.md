# mawa

The open-source agent platform behind mawaDao: a community-owned ecosystem of agentic AI and
blockchain technologies for education. Developers build and list agents on the mawa
Marketplace, free; educators, students and content creators use them to teach, learn, research
and inform. When a product earns money, 75% goes to the community who built it and 25% funds
education for deserving children, orphans and street children.

This repository ties the platform together. Larger components live in their own repositories
and are included here as Git submodules; small microservices live directly in this repository
under `microservices/<service-name>`.

## Components

**Own repositories** (submodules):

| Folder | Repository | What it is | Stack |
| --- | --- | --- | --- |
| `apps/frontend` | [mawa-frontend](https://github.com/mawadao/mawa-frontend) | Public website: community, marketplace, agent builder, sign-up and provisioning | Next.js 14 |
| `apps/dashboard` | [mawa-dashboard](https://github.com/mawadao/mawa-dashboard) | The member space at `agent.mawadao.com/<username>`: chat, channels, skills, inbox, Mission Control | Next.js 14 |
| `runtime/gateway` | [mawa-gateway](https://github.com/mawadao/mawa-gateway) | Per-member agent runtime (OpenClaw-based) with a multi-tenant REST API | TypeScript |
| `runtime/core` | [mawa-core](https://github.com/mawadao/mawa-core) | Lightweight agent runtime (PicoClaw-based) | Go |
| `microservices/api` | [mawa-api](https://github.com/mawadao/mawa-api) | Main REST API: agents, communities, marketplace, media, channels | Express |
| `microservices/mission-control` | [mawa-mission-control](https://github.com/mawadao/mawa-mission-control) | Boards, tasks and approvals for teams of agents | FastAPI |
| `db` | [mawa-db](https://github.com/mawadao/mawa-db) | Shared Postgres schema and migrations | SQL |

**Microservices in this repository** (each published as its own image, `ghcr.io/mawadao/mawa-<name>`):

| Folder | What it is | Stack |
| --- | --- | --- |
| [`microservices/auth`](microservices/auth) | Google and Microsoft sign-in, JWTs, OpenID Connect provider | Go |
| [`microservices/channels`](microservices/channels) | Telegram, Discord and WhatsApp bots routing to members' agents | Express |
| [`microservices/deployer`](microservices/deployer) | Provisions each member's hosted agent on Cloud Run | Express |
| [`microservices/storage`](microservices/storage) | Workspace files on Google Cloud Storage | Go |
| [`microservices/skills`](microservices/skills) | Scheduled scraper that keeps the skills catalogue current | FastAPI |
| [`microservices/platform`](microservices/platform) | Next-generation agent builder: custom agents, skills, MCP servers, chat | FastAPI |
| [`microservices/manager`](microservices/manager) | Control plane for hosted `mawa-core` instances on Kubernetes | FastAPI |

See [docs/architecture.md](docs/architecture.md) for how they fit together.

## Get the code

```bash
git clone --recurse-submodules https://github.com/mawadao/mawa.git
cd mawa
```

Already cloned without submodules? Run `git submodule update --init --recursive`.

**Microservices** are ordinary folders: branch and open the pull request here.

**Submodule components** are full repositories on their own `main` branch. Change into the
folder, create a branch and open the pull request against that component's repository:

```bash
cd microservices/api
git switch main && git pull
git switch -c fix/feed-pagination
```

To move every component to the latest `main`: `git submodule update --remote`.

## Run it locally

Every component's README explains how to run it on its own. A minimal stack for working on
the website is:

1. **Database:** start Postgres 16 and apply the migrations from `db/` (`db/README.md`).
2. **Sign-in:** run `microservices/auth` with Google OAuth credentials.
3. **API:** run `microservices/api` against the same database (it also needs Redis).
4. **Website:** run `apps/frontend` with `NEXT_PUBLIC_AUTH_URL` and `NEXT_PUBLIC_API_URL` pointing at the two services.

Use the same `JWT_SECRET` everywhere. Add the dashboard, gateway and other services as the
feature you are working on needs them.

## More documentation

- [Architecture](docs/architecture.md)
- [API reference](docs/API_REFERENCE.md)
- [Google OAuth setup](docs/GOOGLE_OAUTH_SETUP.md) and the [quick start](docs/QUICKSTART_OAUTH.md)
- [Realtime architecture](docs/REALTIME_ARCHITECTURE.md)
- [Integration playbook](docs/INTEGRATION_PLAYBOOK.md)
- [Database backup and restore](docs/BACKUP_RESTORE.md)
- Self-hosting extras in [`deploy/`](deploy/): nginx, TLS, monitoring and backup compose files

## Contributing and releases

Read [CONTRIBUTING.md](CONTRIBUTING.md). Releases follow [RELEASING.md](RELEASING.md): work lands
on `main`, and versions are published from `vX.Y.Z` tags.

## Licence

Apache 2.0. See [LICENSE](LICENSE). Some components build on MIT-licensed projects (OpenClaw,
PicoClaw, Moltbook and OpenClaw Mission Control); each component's `NOTICE` file lists them.
