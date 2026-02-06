# Database Migration Guide

How to run and troubleshoot database migrations for the Mosbot API. For **conventions when writing migrations** (idempotency, NOT NULL handling, indexes), see the Cursor rule **`.cursor/rules/migrations.mdc`**.

---

## Running migrations

### Full schema (initial setup or reset)

```bash
npm run migrate
```

Runs `src/db/schema.sql`. Used on first deploy and by `npm run db:reset`. The API also runs this on startup (idempotent).

### Single migration file

```bash
node src/db/run-migration.js <migration-file>
```

Example:

```bash
node src/db/run-migration.js 001-add-task-id-to-activity-logs.sql
```

Use the filename only (e.g. `001-add-task-id-to-activity-logs.sql`), not the full path. Files must live in `src/db/migrations/`.

---

## Available migrations

| File | Purpose |
| ---- | ------- |
| `001-add-task-id-to-activity-logs.sql` | Adds `task_id` FK to `activity_logs`. Run if you see `column "task_id" does not exist` on `/api/v1/tasks/:id/activity`. |

---

## Troubleshooting

**"SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string"**  
Env not loaded. Ensure `.env` exists in the project root with correct `DB_*` values. The runner loads `.env` automatically.

**"Migration file not found"**  
File must be in `src/db/migrations/` and you must pass the filename only (e.g. `001-add-task-id-to-activity-logs.sql`).

**"relation 'table_name' does not exist"**  
Schema not applied yet. Run `npm run migrate` (or start the API so it runs schema on startup), then run your migration.

---

## Schema vs migrations

- **schema.sql** – Full schema. Use for initial DB, reset, or dev. Run via `npm run migrate` or API startup.
- **migrations/** – Incremental changes for existing DBs (new columns, tables, data fixes). Run via `node src/db/run-migration.js <file>`.

---

## Planned: migration tracking

A **migration tracking table** and runner (so only pending migrations run) are planned. See **`tasks/005-migration-tracking/task.md`** for scope and task list.

---

## Related files

- `src/db/schema.sql` – Main schema  
- `src/db/migrate.js` – Schema runner  
- `src/db/run-migration.js` – Single-file migration runner  
- `src/db/migrations/` – Migration SQL files  
- `src/db/pool.js` – DB pool  
