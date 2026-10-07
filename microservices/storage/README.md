# mawadao-agent-storage

A small REST service over Google Cloud Storage for members' workspace files and folders.

Part of [mawaDao Agent](https://github.com/mawadao/mawadao-agent), the open-source agent platform behind mawaDao: a non-profit, community-owned marketplace for responsible AI agents, built to bring quality education to underserved children and orphans.

## Endpoints

Routes need the `STORAGE_API_SECRET` bearer token, except health.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/buckets`, `/buckets/:bucket` | List buckets, bucket details |
| GET/POST | `/buckets/:bucket/folders` | List or create folders |
| DELETE | `/buckets/:bucket/folders/*path` | Delete a folder |
| GET/POST/PUT/DELETE | `/buckets/:bucket/files/*path` | Read, upload, replace or delete a file |
| GET | `/health` | Health check |

## Run it locally

Requires Go 1.24+ and Google Cloud application default credentials.

```bash
cp .env.example .env
go run ./cmd       # http://localhost:8090
```

Checks: `go vet ./...`, `go test ./...`.

## Contributing

Read the [contributing guide](https://github.com/mawadao/mawadao-agent/blob/main/CONTRIBUTING.md) before opening a pull request.
Work lands on `main`; releases are tagged `vX.Y.Z` as described in [RELEASING.md](https://github.com/mawadao/mawadao-agent/blob/main/RELEASING.md).

## Licence

Apache 2.0. See [LICENSE](LICENSE).
