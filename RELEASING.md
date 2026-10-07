# Releasing mawaDao Agent

## Branches

- **`main`** is the only long-lived branch in every repository. Everything lands there through reviewed pull requests with green CI, and it must always be releasable.
- **`release/X.Y`** branches are created only when an older version needs a fix after `main` has moved on. Branch from the `vX.Y.Z` tag, cherry-pick the fix from `main`, and release the next patch from that branch.

## Versions

- Every component is versioned on its own with [Semantic Versioning](https://semver.org/), starting at `0.1.0`.
- While a component is below `1.0.0`, a minor release (`0.2.0`) may contain breaking changes. Say so in the changelog.
- Tags are `vX.Y.Z` (for example `v0.3.1`) and are never moved or deleted once pushed.
- The gateway and core track upstream projects. Record the upstream version they are based on in the changelog when it changes.

## Releasing a component

1. Make sure `main` is green.
2. In `CHANGELOG.md`, move the entries under `[Unreleased]` into a new `[X.Y.Z] - YYYY-MM-DD` section.
3. Update the version in `package.json` or `pyproject.toml` if the component has one.
4. Commit on `main` with the message `Release vX.Y.Z`, then tag and push:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin main vX.Y.Z
   ```

5. The release workflow publishes the container image to `ghcr.io/mawadao/<repository>` as `X.Y.Z`, `X.Y` and `latest`, and creates a GitHub release with generated notes. `mawadao-agent-db` publishes release notes only.

## Releasing the platform

A mawaDao Agent release is a set of component versions that have been tested together.

1. Release each component that changed, as above.
2. Here, move each submodule to its release tag:

   ```bash
   git -C services/api fetch --tags && git -C services/api checkout v0.3.1
   git add services/api
   ```

3. Add a section to this repository's `CHANGELOG.md` listing the component versions included.
4. Commit `Release mawaDao Agent vA.B.C`, tag `vA.B.C` and push.

Between platform releases, the submodules may point at any commit on each component's `main`.
