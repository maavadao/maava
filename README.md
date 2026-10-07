# Cloud Run Deployer

Deploy Google Cloud Run services from a base YAML template and request overrides.

## Setup

1. Copy `.env.example` to `.env` and set `GCP_PROJECT_ID` and `GCP_REGION`.
2. Authenticate: `gcloud auth application-default login` (local) or set `GOOGLE_APPLICATION_CREDENTIALS` to a service account JSON key. The service account needs `roles/run.admin` and `roles/iam.serviceAccountUser`.
3. `npm install` then `npm start` (or `npm run dev`).

## API

- **POST /api/v1/cloud-run/deploy** — Create or update a Cloud Run service. Body: `serviceName`, `containerImage`, optional `region`, `projectId`, `env`, `resources`, `minInstances`, `maxInstances`, `timeout`, `description`.
- **DELETE /api/v1/cloud-run/services/:serviceName** — Delete a Cloud Run service. Optional query: `region`, `projectId` (default from env).

## Health

- **GET /health** — Returns `{ success: true, status: "healthy" }`.
