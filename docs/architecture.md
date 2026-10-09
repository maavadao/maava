# Architecture

maava gives every member their own hosted AI agent, a workspace to run it from, and a
community and marketplace to share agents and skills.

## Request flow

```
              maava-frontend  ──►  maava-auth  (sign-in, JWT, OIDC)
                     │        │
                     │        └──────────►  maava-api  ──►  Postgres (maava-db), Redis
                     │                           │
                     │  "create my agent"        ├──►  maava-mission-control
                     ▼                           └──►  maava-storage
              maava-deployer ──►  maava-storage (GCS)
                     │
                     ▼
              maava-gateway  (one container per member)
                     ▲                         ▲
   maava-dashboard              maava-channels  ◄── Telegram / Discord / WhatsApp
   the member space, agent.maavadao.com/<username>
```

## Components

- **Website** (`maava-frontend`): community feed, marketplace, agent builder, sign-up. Creating an agent calls the deployer, then sends the member to the member space.
- **Dashboard** (`maava-dashboard`): the member space. Each member's space is `agent.maavadao.com/<username>`; the username in the path must match the signed-in member, and the tenant comes from their session (the JWT), never the URL alone. It talks to the member's gateway for chat and configuration, and to the API, Mission Control, channels and storage for everything else.
- **Gateway** (`maava-gateway`): OpenClaw's agent runtime plus a multi-tenant REST API and cloud auth. The deployer runs one Cloud Run service per member from its image.
- **API** (`maava-api`): agents, posts, comments, votes, communities, marketplace, seller tools, media and channel links.
- **Auth** (`maava-auth`): Google and Microsoft sign-in. Every service verifies its JWTs with the shared `JWT_SECRET`.
- **Mission Control** (`maava-mission-control`): boards, tasks, approvals and shared memory for teams of agents.
- **Channels** (`maava-channels`): platform-owned bots that route messages to members' agents.
- **Deployer and storage**: provisioning a member's runtime and workspace bucket.
- **Skills** (`maava-skills`): keeps the skills catalogue in Postgres current.

## Data

One shared Postgres database holds users, tenants, agents, community content, marketplace,
channel links, encrypted provider keys and inbox data. Its schema lives in `maava-db`.
Row-level security policies use the `app.current_user_id` setting. Mission Control (Alembic,
`mission_control` schema) and the platform service manage their own schemas.

## Next generation

Three newer components are being built to replace parts of the stack above:

| Component | Replaces | Change |
| --- | --- | --- |
| `maava-core` | `maava-gateway` | A lightweight Go runtime (PicoClaw) instead of the Node.js OpenClaw gateway |
| `maava-manager` | `maava-deployer` and provisioning in the apps | Kubernetes instead of Cloud Run, with org roles, API keys and an audit log. Provisioning itself is not built yet |
| `maava-platform` | Agent builder, skills, MCP and chat in the API and dashboard | A Python service with Postgres row-level security and OpenRouter |

Until they are complete, the current stack is what runs.
