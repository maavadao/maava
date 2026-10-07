# Contributing to mawaDao Agent

Thank you for helping. mawaDao Agent's larger components have their own repositories, tied
together by this repository with Git submodules; small microservices live in this repository under
`microservices/`. This guide covers all of them.

## Find the right repository

Open issues and pull requests on the component you are changing. The table in the
[README](README.md#components) lists every component. Microservices in `microservices/` (auth,
channels, deployer, storage, skills, platform, manager) live in this repository, so their pull
requests come here. If you are not sure where something belongs, open an issue here and we
will move it.

| You want to change | Repository |
| --- | --- |
| A page on the public website | `mawadao-agent-frontend` |
| A member's workspace (chat, channels, inbox, boards) | `mawadao-agent-dashboard` |
| How an agent runs, its tools or skills | `mawadao-agent-gateway` or `mawadao-agent-core` |
| An API endpoint | the service that owns it: `mawadao-agent-api`, `mawadao-agent-mission-control`, or a folder in `microservices/` here |
| A table, column or index | `mawadao-agent-db` (a new migration) |
| A small microservice (auth, channels, deployer, storage, skills, platform, manager) | `mawadao-agent`, in `microservices/<name>` |
| How components are wired together, or the docs here | `mawadao-agent` |

## Workflow

1. Fork the repository and create a branch from `main`, named for the change: `fix/…`, `feat/…`, `docs/…`.
2. Keep each pull request to one change. Small pull requests get reviewed faster.
3. Run the checks listed in the component's README before pushing. CI runs them again on every pull request.
4. Describe what changed and why in the pull request. Link the issue it closes.
5. A maintainer reviews it. Once CI is green and it is approved, it is merged into `main`.

`main` must always build and pass CI. Releases are cut from it as described in
[RELEASING.md](RELEASING.md).

## Changes that span components

Some features touch several repositories, for example a new column, the API that serves it and
the page that shows it.

1. Open one pull request per repository and link them to each other.
2. Merge them in dependency order: `db`, then services, then the runtime, then the apps.
3. Keep each one deployable on its own. For example, add a column before the code that needs it, and stop using a column before dropping it.
4. Once they are merged, open a pull request here that moves the submodules to the new commits.

## Database changes

All shared schema changes are new files in `mawadao-agent-db/migrations/`. Never edit a
migration that has already been released. CI applies every migration to an empty database, so
run `scripts/migrate.sh` locally first. Mission Control and the platform service manage their
own schemas in their own repositories.

## Style

- **Code:** follow the linters and formatters configured in each repository.
- **Commits:** a short subject in the imperative ("Add pagination to the feed"), and a body explaining why when it isn't obvious.
- **Writing:** British English in documentation and interface text (organisation, licence). Write the name as "mawaDao".
- **Secrets:** never commit credentials, `.env` files or real hostnames. Add new settings to `.env.example` with an empty value.

## Security

Do not open public issues for vulnerabilities. Use GitHub's private vulnerability reporting
("Report a vulnerability" under the Security tab) on the affected repository.

## Licence

By contributing you agree that your work is released under the Apache License 2.0, the licence
of every mawaDao Agent repository.
