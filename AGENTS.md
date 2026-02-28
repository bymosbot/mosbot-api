# AGENTS.md — working in this repository

This file is the **universal entrypoint for AI agents** operating in this repo.

## What this repo is

**MosBot API** is the backend layer of MosBot OS — a self-hosted operating system for AI agent work. This repo is also the **canonical documentation home** for the full MosBot OS system (see `docs/README.md`). It is a Node.js/Express service backed by PostgreSQL that transforms and serves data from OpenClaw (the AI agent runtime) via REST endpoints consumed by the MosBot Dashboard.

## Tech stack

- **Node.js / Express** — HTTP server and routing
- **PostgreSQL** — primary data store (via `pg` pool)
- **JWT** — stateless authentication (`jsonwebtoken` + `bcrypt`)
- **SQL migrations** — schema managed via `src/db/runMigrations.js`

## Common commands

```bash
npm install          # install dependencies
npm run dev          # start dev server (nodemon, port 3000)
npm run migrate      # run pending database migrations
npm run db:reset     # reset DB — dev only, destructive
npm test             # run tests in watch mode
npm run test:run     # run tests once (CI mode)
npm run lint         # run ESLint
```

Or via Make (preferred):

```bash
make up        # start full stack via Docker Compose
make down      # stop containers
make dev       # start API locally (requires Postgres running)
make migrate   # run migrations
make test-run  # run tests once
make lint      # lint
```

## Repo shape

```text
src/
  index.js              — Express app entry point
  routes/               — Route modules (one file per resource)
  routes/__tests__/     — Route-level tests
  db/
    pool.js             — Shared pg connection pool
    migrations/         — SQL migration files (001_*.sql, 002_*.sql …)
    runMigrations.js    — Migration runner (runs on startup)
    schema.sql          — Legacy full schema (reference only)
  services/             — External service clients (OpenClaw)
docs/                   — Canonical documentation
docs/archive/           — Historical reference docs (not canonical)
```

## Where to read first

- **Local setup**: `docs/getting-started/first-run.md`
- **Configuration reference**: `docs/configuration.md`
- **Architecture**: `docs/architecture.md`
- **OpenClaw integration**: `docs/openclaw/README.md`
- **Security / secrets**: `docs/security/secrets.md`
- **Cursor rules**: `.cursor/rules/overview.mdc`

## Key principles

1. **`JWT_SECRET` is required** — no hardcoded fallback. The server will refuse to start without it.
2. **`CORS_ORIGIN` cannot be `*`** — must be the exact dashboard origin when credentials are enabled.
3. **Parameterized SQL only** — never interpolate user input into queries.
4. **Migrations are idempotent** — always use `IF NOT EXISTS` guards.
5. **OpenClaw is optional** — all OpenClaw features degrade gracefully when env vars are unset.

## Documentation conventions

- This repo's `docs/README.md` is the **MosBot OS documentation home** — it indexes both API and dashboard docs.
- Dashboard docs live in the dashboard repo; `docs/dashboard.md` in this repo is the pointer/index for them.
- Prefer updating canonical docs in `docs/` rather than adding new root-level markdown files.
- If replacing an older doc, keep it as a short pointer page and preserve original content under `docs/archive/` when useful.
- Engineering patterns and code conventions live in `.cursor/rules/`, not in `docs/`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
