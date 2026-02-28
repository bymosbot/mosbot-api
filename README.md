# MosBot API

[![CI](https://github.com/bymosbot/mosbot-api/actions/workflows/ci.yml/badge.svg)](https://github.com/bymosbot/mosbot-api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

The **API and backend layer** of [MosBot OS](https://github.com/bymosbot/mosbot-dashboard) — a self-hosted operating system for AI agent work.

MosBot API is a Node.js/Express service backed by PostgreSQL. It transforms and serves data from [OpenClaw](docs/integrations/openclaw.md) (the AI agent runtime) and provides REST endpoints consumed by the MosBot Dashboard.

> **Disclaimer:** MosBot OS is vibe-coded with minimal actual code reviews. It is currently used for personal usage only.

## Known bugs / pending fixes

- **Create new agent** — Not working. Do not use.
- **OpenClaw Config update** — May not be as reliable due to REDACTIONS. Prefer using OpenClaw's ControlUI instead.

## TODO

- [ ] Fix the known issues above.
- [ ] Increase code coverage to 100% for API.

## Architecture

```text
┌─────────────────────────────────────────────┐
│         MosBot Dashboard (UI Layer)         │
│  React SPA — task management, org chart,    │
│  workspace visualization                    │
└─────────────────┬───────────────────────────┘
                  │ REST API
┌─────────────────▼───────────────────────────┐
│        MosBot API  ← you are here           │
│  Node.js/Express — transforms and serves    │
│  OpenClaw data via REST endpoints           │
└─────────────────┬───────────────────────────┘
                  │ File/HTTP API
┌─────────────────▼───────────────────────────┐
│      OpenClaw (Source of Truth)             │
│  AI Agent Runtime — manages agents,         │
│  workspaces, and configuration              │
└─────────────────────────────────────────────┘
```

## Quickstart (< 10 minutes)

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose v2
- [Node.js 20+](https://nodejs.org/) (for local dev without Docker)
- A sibling checkout of [mosbot-dashboard](https://github.com/bymosbot/mosbot-dashboard) (for the full stack)

### 1. Clone both repos side-by-side

```bash
git clone https://github.com/bymosbot/mosbot-api.git
git clone https://github.com/bymosbot/mosbot-dashboard.git
```

Your directory layout should look like:

```text
parent-folder/
├── mosbot-api/
└── mosbot-dashboard/
```

### 2. Configure environment

```bash
cd mosbot-api
cp .env.example .env
```

Edit `.env` and set at minimum:

| Variable | Example |
| -------- | ------- |
| `DB_PASSWORD` | `a-strong-password` |
| `JWT_SECRET` | run `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `BOOTSTRAP_OWNER_EMAIL` | `admin@example.com` |
| `BOOTSTRAP_OWNER_PASSWORD` | `another-strong-password` |

### 3. Start the full stack

```bash
make up
# or: docker compose up -d
```

This starts **Postgres + MosBot API + MosBot Dashboard** in one command. The dashboard runs as a **Vite dev server with hot-reload** — every file save in `mosbot-dashboard/` reflects instantly in the browser, no rebuild needed.

| Service | URL |
| ------- | --- |
| API | <http://localhost:3000> |
| Dashboard | <http://localhost:5173> |

### 4. Verify

```bash
curl http://localhost:3000/health
# → {"status":"ok","timestamp":"..."}
```

Open <http://localhost:5173> and log in with the credentials you set in `BOOTSTRAP_OWNER_EMAIL` / `BOOTSTRAP_OWNER_PASSWORD`.

**After the first login**, remove `BOOTSTRAP_OWNER_PASSWORD` from your `.env`.

### OpenClaw integration (optional)

To use agent management, workspace browsing, and org chart features, MosBot API must reach two OpenClaw endpoints:

| Service | Default port | Purpose |
| ------- | ------------ | ------- |
| **Workspace** | `8080` | File access, config, org chart |
| **Gateway** | `18789` | Runtime control, tool invocation |

**Ensure endpoints are accessible** from wherever the API runs:

- **OpenClaw runs locally** — Use `http://localhost:8080` and `http://localhost:18789` in `.env`.
- **OpenClaw runs in Kubernetes** — Port-forward both services, then point the API at localhost (or `host.docker.internal` if the API runs in Docker):

  ```bash
  # Terminal 1: Workspace
  kubectl port-forward -n <namespace> svc/openclaw-workspace 8080:8080

  # Terminal 2: Gateway
  kubectl port-forward -n <namespace> svc/openclaw 18789:18789
  ```

- **OpenClaw runs on a VPS or remote host** — Expose ports 8080 and 18789 on the VPS (firewall/security group). If MosBot API runs on the **same** VPS, use `http://localhost:8080` and `http://localhost:18789`. If the API runs elsewhere, use the VPS hostname or IP (e.g. `http://openclaw.example.com:8080`). Prefer a VPN or private network when exposing these services across the internet.

Add to `.env`: `OPENCLAW_WORKSPACE_URL`, `OPENCLAW_WORKSPACE_TOKEN`, `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`. See [docs/openclaw/README.md](docs/openclaw/README.md) and [docs/guides/openclaw-local-development.md](docs/guides/openclaw-local-development.md) for details.

> **Production build:** to run the dashboard as an optimised nginx bundle instead, use `make up-prod` (or `docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build`). This is only needed for production deployments — day-to-day development uses `make up`.

See [docs/getting-started/first-run.md](docs/getting-started/first-run.md) for the full setup guide.

## Local dev (without Docker)

```bash
npm install
cp .env.example .env   # edit DB_* to point at a local Postgres
npm run migrate
npm run dev
```

## Available commands

```bash
make up          # start full stack in dev mode (Vite HMR dashboard + API + Postgres)
make up-prod     # start full stack with production dashboard build (nginx)
make down        # stop containers
make dev         # start API in local dev mode (nodemon, requires Postgres separately)
make lint        # run ESLint
make test-run    # run tests once (CI mode)
make migrate     # run database migrations
make db-reset    # reset database (dev only, destructive)
```

## Documentation

- [Getting started](docs/guides/local-development.md)
- [First-run setup](docs/getting-started/first-run.md)
- [Configuration reference](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [Docker guide](docs/guides/docker.md)
- [Database migrations](docs/guides/database-migrations.md)
- [OpenClaw integration](docs/openclaw/README.md)
- [Deployment](docs/deployment.md)
- [Security / secrets](docs/security/secrets.md)
- [API contract](docs/api/openclaw-public-api.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
