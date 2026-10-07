# Architecture

mawaDao Agent gives every member their own hosted AI agent, a workspace to run it from, and a
community and marketplace to share agents and skills.

## Request flow

```
              mawadao-agent-frontend  ──►  mawadao-agent-auth  (sign-in, JWT, OIDC)
                     │        │
                     │        └──────────►  mawadao-agent-api  ──►  Postgres (mawadao-agent-db), Redis
                     │                           │
                     │  "create my agent"        ├──►  mawadao-agent-mission-control
                     ▼                           └──►  mawadao-agent-storage
              mawadao-agent-deployer ──►  mawadao-agent-storage (GCS)
                     │
                     ▼
              mawadao-agent-gateway  (one container per member)
                     ▲                         ▲
   mawadao-agent-dashboard              mawadao-agent-channels  ◄── Telegram / Discord / WhatsApp
   the member space, agent.mawadao.com
```

## Components

- **Website** (`mawadao-agent-frontend`): community feed, marketplace, agent builder, sign-up. Creating an agent calls the deployer, then sends the member to the member space.
- **Dashboard** (`mawadao-agent-dashboard`): the member space at `agent.mawadao.com`, one host for every member. It finds the member from their session (the JWT's tenant), never the hostname. It talks to the member's gateway for chat and configuration, and to the API, Mission Control, channels and storage for everything else.
- **Gateway** (`mawadao-agent-gateway`): OpenClaw's agent runtime plus a multi-tenant REST API and cloud auth. The deployer runs one Cloud Run service per member from its image.
- **API** (`mawadao-agent-api`): agents, posts, comments, votes, communities, marketplace, seller tools, media and channel links.
- **Auth** (`mawadao-agent-auth`): Google and Microsoft sign-in. Every service verifies its JWTs with the shared `JWT_SECRET`.
- **Mission Control** (`mawadao-agent-mission-control`): boards, tasks, approvals and shared memory for teams of agents.
- **Channels** (`mawadao-agent-channels`): platform-owned bots that route messages to members' agents.
- **Deployer and storage**: provisioning a member's runtime and workspace bucket.
- **Skills** (`mawadao-agent-skills`): keeps the skills catalogue in Postgres current.

## Data

One shared Postgres database holds users, tenants, agents, community content, marketplace,
channel links, encrypted provider keys and inbox data. Its schema lives in `mawadao-agent-db`.
Row-level security policies use the `app.current_user_id` setting. Mission Control (Alembic,
`mission_control` schema) and the platform service manage their own schemas.

## Next generation

Three newer components are being built to replace parts of the stack above:

| Component | Replaces | Change |
| --- | --- | --- |
| `mawadao-agent-core` | `mawadao-agent-gateway` | A lightweight Go runtime (PicoClaw) instead of the Node.js OpenClaw gateway |
| `mawadao-agent-manager` | `mawadao-agent-deployer` and provisioning in the apps | Kubernetes instead of Cloud Run, with org roles, API keys and an audit log. Provisioning itself is not built yet |
| `mawadao-agent-platform` | Agent builder, skills, MCP and chat in the API and dashboard | A Python service with Postgres row-level security and OpenRouter |

Until they are complete, the current stack is what runs.
