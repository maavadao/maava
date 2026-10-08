# Releasing mawa

## Branches

- **`main`** is the only long-lived branch in every repository. Everything lands there through reviewed pull requests with green CI, and it must always be releasable.
- **`release/X.Y`** branches are created only when an older version needs a fix after `main` has moved on. Branch from the `vX.Y.Z` tag, cherry-pick the fix from `main`, and release the next patch from that branch.

## Versions

- Every component is versioned on its own with [Semantic Versioning](https://semver.org/), starting at `0.1.0`.
- While a component is below `1.0.0`, a minor release (`0.2.0`) may contain breaking changes. Say so in the changelog.
- Tags are `vX.Y.Z` (for example `v0.3.1`), or `<name>-vX.Y.Z` for microservices in this repository. They are never moved or deleted once pushed.
- The gateway and core track upstream projects. Record the upstream version they are based on in the changelog when it changes.

## Releasing a component

Components in their own repository are released from that repository. Microservices in
`microservices/` are released from this repository with a tag named after the service; see
[Releasing a microservice](#releasing-a-microservice).

### In its own repository

1. Make sure `main` is green.
2. In `CHANGELOG.md`, move the entries under `[Unreleased]` into a new `[X.Y.Z] - YYYY-MM-DD` section.
3. Update the version in `package.json` or `pyproject.toml` if the component has one.
4. Commit on `main` with the message `Release vX.Y.Z`, then tag and push:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin main vX.Y.Z
   ```

5. The release workflow publishes the container image to `ghcr.io/mawadao/<repository>` as `X.Y.Z`, `X.Y` and `latest`, and creates a GitHub release with generated notes. `mawa-db` publishes release notes only.

## Releasing a microservice

Microservices in `microservices/<name>` are versioned on their own, but their tags live in this
repository as `<name>-vX.Y.Z` (for example `auth-v0.2.0`).

1. Update `microservices/<name>/CHANGELOG.md` and, if it has one, the version in `package.json` or `pyproject.toml`.
2. Commit on `main` with the message `Release <name> vX.Y.Z`, then tag and push:

   ```bash
   git tag -a auth-v0.2.0 -m "auth v0.2.0"
   git push origin main auth-v0.2.0
   ```

3. `.github/workflows/release-microservice.yml` publishes `ghcr.io/mawadao/mawa-<name>` as `X.Y.Z` and `latest`, and creates a GitHub release.

## Releasing the platform

A mawa release is a set of component versions that have been tested together.

1. Release each component that changed, as above.
2. Here, move each submodule to its release tag (microservices are already in this repository at the release commit):

   ```bash
   git -C microservices/api fetch --tags && git -C microservices/api checkout v0.3.1
   git add microservices/api
   ```

3. Add a section to this repository's `CHANGELOG.md` listing the component versions included.
4. Commit `Release mawa vA.B.C`, tag `vA.B.C` and push.

Between platform releases, the submodules may point at any commit on each component's `main`.
