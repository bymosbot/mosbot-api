---
paths:
  - "src/**/*.js"
---

# Architecture

## Folder boundaries

| Folder | Owns |
| ------ | ---- |
| `src/routes/` | One file per resource; HTTP handling only |
| `src/db/` | Pool, migrations, schema — no business logic |
| `src/services/` | External service clients (e.g. OpenClaw) |
| `src/jobs/` | Background and scheduled jobs |
| `src/utils/` | Shared utilities |
| `src/index.js` | Middleware registration and route mounting only |

## Express conventions

- Mount all routes under `/api/v1/*`.
- Keep middleware order: `helmet` → `cors` → routes → error handler → 404 handler.
- The 404 handler is always last.
- Centralized error handler returns `{ error: { message, status } }` — no stack traces in responses.
- `/health` is a simple JSON liveness check with no auth.

## Database

- Use the shared pool from `src/db/pool.js` — never create a new `pg.Pool`.
- Parameterized queries only: `$1, $2, ...` — never string-interpolate user input.
- Check for record existence before updates/deletes; return `404` if not found.

## Migrations

- All schema changes go in `src/db/migrations/XXX_description.sql` (zero-padded, sequential).
- Migrations must be idempotent: use `IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, etc.
- Add a NOT NULL column in three steps: add nullable → backfill → set NOT NULL.
- Add an index on every new foreign key column.
- Wrap multi-step migrations in a transaction (`BEGIN; ... COMMIT;`).
- Never edit a migration already applied in production — add a new one instead.

## Backwards compatibility

- Additive changes (new endpoints, new optional fields) are safe without a version bump.
- Breaking changes require a new version prefix (`/api/v2/`) or a deprecation notice.
- Deprecate before removing: mark in docs, keep the old endpoint for at least one release cycle.

## External integrations

- Service URLs and tokens come from env vars — never hardcoded.
- All integrations degrade gracefully when their env vars are unset (feature unavailable, not crash).
- Validate and sanitize all data from external services before use.

## Documentation

- Update `docs/` when adding a new endpoint, env var, or migration.
- New env vars must be added to `.env.example` with a placeholder.
- Do not include internal hostnames, cluster addresses, or deployment-specific URLs in docs.
