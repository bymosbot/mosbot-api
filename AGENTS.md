# AGENTS.md — working in this repository

This file is the **universal entrypoint for AI agents** operating in this repo.

## What this repo is

- **Mosbot API**: Node.js + Express API backed by PostgreSQL.
- **Docs**: Human-oriented docs live in `docs/` (some are also agent-friendly).

## Where to read first

- **Docs index**: `docs/README.md`
- **Public API contract (OpenClaw integration)**: `docs/api/openclaw-public-api.md`
- **OpenClaw workspace integration (implementation)**: `docs/openclaw/workspace/`
- **RBAC policy**: `docs/security/roles-and-permissions.md`
- **Cursor rules (agent behavior + patterns)**: `.cursor/rules/overview.mdc` (and other `.cursor/rules/*.mdc`)

## Common commands

```bash
# install
npm install

# run migrations
npm run migrate

# reset DB (development only; destructive)
npm run db:reset

# dev server
npm run dev

# tests / lint
npm test
npm run lint
```

## Repo shape (high level)

- `src/` — Express app, routes, DB code
- `src/db/migrations/` — SQL migrations (run via `npm run migrate`)
- `docs/` — canonical documentation
- `docs/archive/` — historical reference docs (not canonical)

## Documentation conventions

- Prefer updating canonical docs in `docs/` rather than adding new root-level markdown files.
- If replacing an older doc, keep it as a short pointer page and preserve original content under `docs/archive/` when useful.
