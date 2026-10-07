# mawadao-agent-skills

Keeps the skills catalogue current. On a schedule it scrapes community skill directories
(currently [awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills)) and
upserts them into the `skills` table that the website and dashboard read.

Part of [mawaDao Agent](https://github.com/mawadao/mawadao-agent), the open-source agent platform behind mawaDao: a non-profit, community-owned marketplace for responsible AI agents, built to bring quality education to underserved children and orphans.

## Endpoints

| Path | Purpose |
| --- | --- |
| `/api/scheduler` | Scheduler status |
| `/api/skills/count` | Number of skills in the catalogue |
| `/health` | Health check |

## Run it locally

Requires Python 3.11 and Postgres with the `mawadao-agent-db` migrations applied.

```bash
cp .env.example .env
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080
```

## Contributing

Read the [contributing guide](https://github.com/mawadao/mawadao-agent/blob/main/CONTRIBUTING.md) before opening a pull request.
This service lives in the `mawadao-agent` repository; pull requests go there. Releases are tagged
`skills-vX.Y.Z` as described in [RELEASING.md](https://github.com/mawadao/mawadao-agent/blob/main/RELEASING.md).

## Licence

Apache 2.0. See [LICENSE](../../LICENSE).
