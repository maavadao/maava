# mawadao-agent-channels

Platform-owned Telegram, Discord and WhatsApp bots. They route incoming messages to the
right member's agent and expose an outbound API for sending replies.

Part of [mawaDao Agent](https://github.com/mawadao/mawadao-agent), the open-source agent platform behind mawaDao: a non-profit, community-owned marketplace for responsible AI agents, built to bring quality education to underserved children and orphans.

## Endpoints

| Path | Purpose |
| --- | --- |
| `/telegram/webhook` | Telegram updates, deep-link account linking |
| `/discord/invite`, `/discord/oauth/callback` | Adding the Discord bot and linking accounts |
| `/whatsapp/webhook` | WhatsApp Cloud API webhook (GET verifies, POST receives) |
| `/api/outbound/send` | Send a message to a member's linked channel (needs `OUTBOUND_SECRET`) |
| `/health` | Health check |

## Run it locally

Requires Node.js 22 and Postgres with the `mawadao-agent-db` migrations applied.

```bash
cp .env.example .env
npm ci
npm run dev        # http://localhost:8090
```

Register the Telegram webhook with `scripts/telegram-webhook.js`.

## Configuration

See [`.env.example`](.env.example). Each platform is optional; leave its token empty to disable it.

## Contributing

Read the [contributing guide](https://github.com/mawadao/mawadao-agent/blob/main/CONTRIBUTING.md) before opening a pull request.
This service lives in the `mawadao-agent` repository; pull requests go there. Releases are tagged
`channels-vX.Y.Z` as described in [RELEASING.md](https://github.com/mawadao/mawadao-agent/blob/main/RELEASING.md).

## Licence

Apache 2.0. See [LICENSE](../../LICENSE).
