# bucket-manager microservice

Lightweight Go/Gin microservice responsible for bucket metadata management.

## Structure

- `cmd/main.go` – service entrypoint, HTTP server & routing
- `config/config.go` – environment-based configuration loader
- `handlers/buckets.go` – HTTP handlers for `/api/v1/buckets` endpoints
- `.env.example` – example configuration for local development
- `go.mod` – Go module definition and dependencies

The layout mirrors the `auth` microservice for consistency.

## Running locally

```bash
cd apps/microservices/bucket-manager
cp .env.example .env  # then edit as needed
go run ./cmd
```

By default the service listens on `:8090` and exposes:

- `GET /` – basic service info
- `GET /health` – simple health check
- `GET /api/v1/buckets` – list buckets
- `GET /api/v1/buckets/:name` – metadata for a single bucket

**Folders**

- `POST /api/v1/buckets/:bucket/folders` – create folder. Body: `{"path": "folder/sub"}`
- `GET /api/v1/buckets/:bucket/folders?path=...` – list folder contents (path optional, empty = root)

**Files**

- `POST /api/v1/buckets/:bucket/files` – upload file. Form: `path` (object key), `file` (multipart file)
- `PUT /api/v1/buckets/:bucket/files/*path` – modify file (full replace). Body = new content
- `DELETE /api/v1/buckets/:bucket/files/*path` – delete file

Handlers are stubs; wire them to your storage backend (e.g. GCS, S3) as needed.

