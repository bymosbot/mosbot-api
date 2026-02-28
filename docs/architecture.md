# Architecture

MosBot OS is a three-layer system:

```text
┌─────────────────────────────────────────────┐
│         MosBot Dashboard (UI Layer)         │
│  React SPA — task management, org chart,    │
│  workspace visualization, agent monitoring  │
└─────────────────┬───────────────────────────┘
                  │ REST API (HTTP/JSON)
                  │ Auth: JWT Bearer token
┌─────────────────▼───────────────────────────┐
│        MosBot API (Backend Proxy)           │
│  Node.js/Express + PostgreSQL               │
│  Transforms and serves OpenClaw data        │
└─────────────────┬───────────────────────────┘
                  │ HTTP + WebSocket
┌─────────────────▼───────────────────────────┐
│      OpenClaw (Source of Truth)             │
│  AI Agent Runtime — manages agents,         │
│  workspaces, sessions, and cron jobs        │
└─────────────────────────────────────────────┘
```

## Components

### MosBot Dashboard

- **Tech**: React 18, Vite, Tailwind CSS, Zustand, Axios
- **Role**: UI layer only. Reads from and writes to MosBot API. Never talks to OpenClaw directly.
- **Auth**: JWT tokens stored in `localStorage`, sent as `Authorization: Bearer` header.
- **Deployment**: Static site (Vite build output). Can be served by nginx, CDN, or any static host.

### MosBot API

- **Tech**: Node.js 20, Express 4, PostgreSQL 15, bcrypt, jsonwebtoken
- **Role**: Transformation and persistence layer. Owns user accounts, tasks, activity logs, and standups. Proxies OpenClaw data.
- **Auth**: Issues and verifies JWT tokens. All routes (except `/health`, `/api/v1/config`, `/api/v1/auth/*`) require a valid token.
- **Deployment**: Docker container. Runs migrations on startup.

### OpenClaw

- **Role**: AI agent runtime. Source of truth for agent definitions, workspaces, sessions, and cron jobs.
- **Integration**: MosBot API connects to two OpenClaw services:
  - **Workspace service** (HTTP REST) — reads/writes `openclaw.json` and workspace files
  - **Gateway** (HTTP + WebSocket RPC) — queries live sessions and invokes tools
- **Optional**: MosBot API degrades gracefully when OpenClaw is not configured. Task management and user management work without it.

## Database

PostgreSQL 15. Schema managed by sequential SQL migrations in `src/db/migrations/`.

Key tables:

| Table | Purpose |
| ----- | ------- |
| `users` | User accounts with roles (`owner`, `agent`, `admin`, `user`) |
| `tasks` | Task management (kanban, dependencies, comments) |
| `activity_logs` | System-wide activity feed |
| `session_usage` | Aggregated AI session cost/token data |
| `standups` | Daily standup summaries |
| `model_pricing` | Cached OpenRouter model pricing data |

## Authentication flow

```text
Dashboard                MosBot API              PostgreSQL
   │                         │                       │
   │  POST /auth/login        │                       │
   │  {email, password}  ──► │                       │
   │                         │  SELECT user by email ►│
   │                         │◄─ user row ────────────│
   │                         │  bcrypt.compare()      │
   │                         │  jwt.sign()            │
   │◄── {token, user} ───────│                       │
   │                         │                       │
   │  GET /tasks              │                       │
   │  Authorization: Bearer ►│                       │
   │                         │  jwt.verify()          │
   │                         │  SELECT user (fresh)  ►│
   │◄── tasks[] ─────────────│                       │
```

## OpenClaw integration

OpenClaw integration is **optional**. When `OPENCLAW_WORKSPACE_URL` or `OPENCLAW_GATEWAY_URL` are not set, endpoints that depend on them return `503 SERVICE_NOT_CONFIGURED` and the dashboard shows a degraded state.

See [docs/openclaw/README.md](openclaw/README.md) for integration details.
