# mawa-auth

The sign-in service. It handles Google and Microsoft OAuth, issues the JWTs the other
components trust, and acts as an OpenID Connect provider.

Part of [mawa](https://github.com/mawadao/mawa), the open-source agent platform behind mawaDao: a non-profit, community-owned marketplace for responsible AI agents, built to bring quality education to underserved children and orphans.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/auth/google`, `/auth/google/callback` | Google sign-in |
| GET | `/auth/microsoft`, `/auth/microsoft/callback` | Microsoft sign-in |
| GET | `/auth/profile` | Current user |
| GET | `/auth/logout` | Sign out |
| GET | `/.well-known/openid-configuration`, `/oauth2/jwks` | OIDC discovery and keys |
| GET/POST | `/oauth2/authorize`, `/oauth2/token` | OIDC authorisation code flow |
| GET | `/health` | Health check |

## Run it locally

Requires Go 1.23+ and Postgres with the `mawa-db` migrations applied.

```bash
cp .env.example .env
go run ./cmd       # http://localhost:8080
```

Checks: `go vet ./...`, `go test ./...`.

## Configuration

See [`.env.example`](.env.example). `JWT_SECRET` must match every service that verifies tokens.
`OIDC_PRIVATE_KEY_PEM` and `OIDC_KEY_ID` sign OIDC ID tokens.

## Contributing

Read the [contributing guide](https://github.com/mawadao/mawa/blob/main/CONTRIBUTING.md) before opening a pull request.
This service lives in the `mawa` repository; pull requests go there. Releases are tagged
`auth-vX.Y.Z` as described in [RELEASING.md](https://github.com/mawadao/mawa/blob/main/RELEASING.md).

## Licence

Apache 2.0. See [LICENSE](../../LICENSE).
