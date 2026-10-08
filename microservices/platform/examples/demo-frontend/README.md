# Demo frontend

Minimal Next.js client for the mawa Platform API. Intended for local demos
only — the product UI lives in mawa-dashboard.

Features: connect with a dev token, view your user/org, create and list
agents, and chat with an agent (SSE streaming via OpenRouter).

## Prerequisites

- Node.js 20+
- The API running on `:8080` (see the repo root README)
- An OpenRouter API key exported for the API process, or chat will return an
  error event: `export AP_OPENROUTER_API_KEY=sk-or-...`

## Run

```bash
make demo-seed       # from repo root: seeds demo org/user, prints a 24h dev JWT
make demo-frontend   # npm install + next dev on :3000
```

Open <http://localhost:3000>, paste the token from `make demo-seed`, and click
**Connect**. Create an agent, pick it in the Chat section, and send a message.

The token and API URL are kept in `localStorage`, so reloading reconnects
automatically.
