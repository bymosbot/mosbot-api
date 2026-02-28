# Pre-release Checklist

Use this checklist before tagging a new release.

## Versioning

We use [Semantic Versioning](https://semver.org/):

- `MAJOR` — breaking API or configuration changes
- `MINOR` — new features, backward-compatible
- `PATCH` — bug fixes, backward-compatible

## Release steps

### 1. Prepare

- [ ] All planned changes are merged to `main`
- [ ] `CHANGELOG.md` updated with release notes under a new `[x.y.z]` section
- [ ] Version bumped in `package.json` (`npm version x.y.z --no-git-tag-version`)
- [ ] No open security advisories for this release

### 2. Verify

- [ ] CI passes on `main` (lint, tests, build, secret scan)
- [ ] `docker compose up` works from a clean checkout
- [ ] `make test-run` passes
- [ ] No secrets or internal references in the diff

### 3. Tag and release

```bash
git tag -a v1.2.3 -m "Release v1.2.3"
git push origin v1.2.3
```

The `release.yml` GitHub Actions workflow will:

- Build and push Docker images to GHCR with the version tag
- Create a GitHub Release draft with auto-generated notes

### 4. Publish

- [ ] Review and publish the GitHub Release draft
- [ ] Update `CHANGELOG.md` links at the bottom of the file
- [ ] Announce in relevant channels if applicable

## Docker image tags

| Tag | When created |
| --- | ------------ |
| `ghcr.io/bymosbot/mosbot-api:v1.2.3` | On tag push |
| `ghcr.io/bymosbot/mosbot-api:latest` | On tag push |
| `ghcr.io/bymosbot/mosbot-api:main` | On every merge to main |
| `ghcr.io/bymosbot/mosbot-api:sha-abc1234` | On every merge to main |

Same pattern applies for `mosbot-dashboard`.

## Post-release

- [ ] Verify images are available on GHCR
- [ ] Test pulling and running the tagged image
- [ ] Update any deployment manifests (e.g. Kubernetes) to the new tag
