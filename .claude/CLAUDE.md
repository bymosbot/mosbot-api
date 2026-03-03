# MosBot API

Backend layer of MosBot OS — a self-hosted operating system for AI agent work. Node.js/Express service backed by PostgreSQL that transforms and serves data from OpenClaw (the AI agent runtime) via REST endpoints consumed by the MosBot Dashboard.

## Tech stack

- **Node.js / Express** — HTTP server and routing
- **PostgreSQL** — primary data store (via `pg` pool)
- **JWT** — stateless authentication (`jsonwebtoken` + `bcrypt`)
- **SQL migrations** — schema managed via `src/db/runMigrations.js`

## Commands

```bash
make up          # start full stack via Docker Compose
make down        # stop containers
make dev         # start API locally (requires Postgres running)
make migrate     # run migrations
make test-run    # run tests once (CI)
make lint        # ESLint

# Without Make:
npm run dev          # dev server (nodemon, port 3000)
npm run migrate      # run pending migrations
npm run db:reset     # reset DB (dev only, destructive)
npm run test:run     # tests once
npm run lint         # ESLint
```

## Repo shape

```
src/
  index.js              — Express app entry point (middleware + route mounting only)
  routes/               — One file per resource
  routes/__tests__/     — Route-level tests
  db/
    pool.js             — Shared pg connection pool
    migrations/         — SQL migration files (001_*.sql …)
    runMigrations.js    — Migration runner (runs on startup)
  services/             — External service clients (OpenClaw)
  jobs/                 — Background/scheduled jobs
  utils/                — Shared utilities
docs/                   — Canonical documentation
```

## Non-negotiables

1. `JWT_SECRET` is required — no hardcoded fallback. Server refuses to start without it.
2. `CORS_ORIGIN` cannot be `*` when credentials are enabled — must be exact dashboard origin.
3. Parameterized SQL only — never interpolate user input into queries.
4. Migrations are idempotent — always use `IF NOT EXISTS` guards.
5. OpenClaw is optional — all OpenClaw features degrade gracefully when env vars are unset.

## Docs

- Local setup: `docs/getting-started/first-run.md`
- Architecture: `docs/architecture.md`
- OpenClaw integration: `docs/openclaw/README.md`
- Configuration reference: `docs/configuration.md`
