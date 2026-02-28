# Secret and Configuration Management

This document describes how MosBot API handles secrets and sensitive configuration.

## Where configuration lives

| Location | Purpose |
| -------- | ------- |
| `.env` (local) | Local development overrides. Never committed. |
| Environment variables | Runtime config injected by Docker Compose, Kubernetes, or your CI/CD platform. |
| GitHub Actions secrets | Used by CI/CD workflows (e.g. `JWT_SECRET`, `DB_PASSWORD`). |
| `k8s/base/secret.template.yaml` | Template for Kubernetes Secret manifests. Copy to `secret.yaml` (gitignored) and fill in base64-encoded values. |

## Required environment variables

Copy `.env.example` to `.env` and fill in all required values before starting the API.

| Variable | Required | Description |
| -------- | -------- | ----------- |
| `DB_PASSWORD` | **Yes** | PostgreSQL password |
| `JWT_SECRET` | **Yes** | JWT signing secret (min 32 chars). Generate with: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `CORS_ORIGIN` | **Yes** | Exact dashboard origin (e.g. `https://dashboard.example.com`). Cannot be `*`. |
| `BOOTSTRAP_OWNER_EMAIL` | First run | Email for the initial owner account |
| `BOOTSTRAP_OWNER_PASSWORD` | First run | Password for the initial owner account (min 12 chars) |
| `OPENCLAW_WORKSPACE_TOKEN` | If using OpenClaw | Bearer token for the workspace service |
| `OPENCLAW_GATEWAY_TOKEN` | If using OpenClaw | Bearer token for the gateway service |
| `OPENCLAW_DEVICE_PRIVATE_KEY` | If using device auth | Ed25519 private key (base64url) |
| `OPENCLAW_DEVICE_TOKEN` | If using device auth | Device pairing token |

See `.env.example` for the full list with descriptions and defaults.

## Bootstrap flow (first run)

On a fresh database, set `BOOTSTRAP_OWNER_EMAIL` and `BOOTSTRAP_OWNER_PASSWORD` before starting
the API. The post-migration script creates the owner account once, then skips on subsequent starts.

**After the first login, remove `BOOTSTRAP_OWNER_PASSWORD` from your environment.**

## Rotating secrets

### JWT secret

1. Generate a new secret: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
2. Update `JWT_SECRET` in your environment / secrets manager.
3. Restart the API. All existing JWT tokens are immediately invalidated — users must log in again.

### Database password

1. Update the password in PostgreSQL.
2. Update `DB_PASSWORD` in your environment.
3. Restart the API.

### OpenClaw tokens

Follow the OpenClaw documentation to regenerate workspace/gateway tokens, then update the
corresponding `OPENCLAW_*_TOKEN` variables and restart.

## What NOT to commit

- `.env` files (any variant)
- `k8s/base/secret.yaml` (the filled-in secret manifest)
- Private key files (`*.pem`, `*.key`, `*.p12`, etc.)
- Service account JSON files
- Database dumps containing real data

These patterns are already covered by `.gitignore`.

## Automated secret scanning

Pull requests and pushes to `main` are scanned by [Gitleaks](https://github.com/gitleaks/gitleaks)
via the CI workflow (`.github/workflows/ci.yml`). If a scan fails, no secrets have been pushed yet
— fix the finding before merging.
