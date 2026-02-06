# Database Migration Guide

How to run and troubleshoot database migrations for the Mosbot API. For **conventions when writing migrations** (idempotency, NOT NULL handling, indexes), see the Cursor rule **`.cursor/rules/migrations.mdc`**.

---

## Migration System Overview

The Mosbot API uses an **automated migration tracking system** that:

- Tracks which migrations have been applied using a `schema_migrations` table
- Runs only pending migrations in filename order
- Ensures migrations are applied exactly once
- Provides an audit trail of when each migration was applied

### How it works

1. **Tracking table**: The `schema_migrations` table records which migration files have been applied
2. **Automatic execution**: On API startup, the runner checks for pending migrations and applies them
3. **Ordered execution**: Migrations run in alphabetical order (e.g., `000_*.sql`, `001_*.sql`, `002_*.sql`)
4. **Transactional safety**: Each migration runs in a transaction; if it fails, it's not recorded as applied

---

## Running migrations

### Automatic (recommended)

Migrations run automatically when you start the API:

```bash
npm start
```

The API will:

1. Create the `schema_migrations` table if it doesn't exist
2. Check for pending migrations in `src/db/migrations/`
3. Apply any pending migrations in order
4. Log which migrations were applied

### Manual

To run migrations manually without starting the API:

```bash
npm run migrate
```

This is useful for:

- Setting up a fresh database
- Applying migrations before deployment
- Testing migrations in isolation

### Database reset

To drop all tables and re-run all migrations from scratch:

```bash
npm run db:reset
```

⚠️ **Warning**: This deletes all data! Use only in development.

---

## Migration files

### File naming convention

Migration files must follow this naming pattern:

```
XXX_short_description.sql
```

- **XXX**: Zero-padded 3-digit sequential number (e.g., `001`, `002`, `003`)
- **short_description**: Brief description using underscores (e.g., `add_user_preferences`)
- **Extension**: Must be `.sql`

Examples:

- `000_create_migrations_table.sql` (bootstrap migration)
- `001_initial_schema.sql` (baseline schema)
- `002_add_task_priority.sql` (incremental change)

### Current migrations

| File | Purpose | Status |
| ---- | ------- | ------ |
| `000_create_migrations_table.sql` | Creates the `schema_migrations` tracking table | Bootstrap |
| `001_initial_schema.sql` | Creates all tables, functions, triggers, and seed data | Baseline |

### Adding a new migration

1. **Create the file** in `src/db/migrations/` with the next sequential number:

   ```bash
   # Example: adding a new column
   touch src/db/migrations/002_add_task_priority.sql
   ```

2. **Write idempotent SQL** (see conventions in `.cursor/rules/migrations.mdc`):

   ```sql
   -- Add priority column to tasks table
   ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority VARCHAR(50);
   
   -- Add index for the new column
   CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
   ```

3. **Test the migration**:

   ```bash
   npm run migrate
   ```

4. **Verify it was applied**:

   ```sql
   SELECT * FROM schema_migrations ORDER BY applied_at DESC LIMIT 1;
   ```

### Idempotency requirements

All migrations must be **idempotent** (safe to run multiple times). Use:

- `CREATE TABLE IF NOT EXISTS`
- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
- `CREATE INDEX IF NOT EXISTS`
- `CREATE OR REPLACE FUNCTION`
- `DO $$ ... END $$` blocks with existence checks

See `.cursor/rules/migrations.mdc` for detailed patterns.

---

## Troubleshooting

### "SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string"

Environment variables not loaded. Ensure `.env` exists in the project root with correct `DB_*` values:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=mosbot
DB_USER=mosbot
DB_PASSWORD=your_password
```

### "Migration failed" during startup

Check the error message for details. Common causes:

- **Syntax error in SQL**: Review the migration file for SQL syntax errors
- **Constraint violation**: The migration may conflict with existing data
- **Missing dependency**: The migration may reference tables/columns that don't exist yet

To fix:

1. Review the failed migration file
2. Fix the issue
3. The migration will retry on next startup (failed migrations are not recorded)

### "No migration files found"

The `src/db/migrations/` directory is empty or doesn't exist. This is normal for a fresh checkout. The directory will be created automatically, and you can add migration files as needed.

### Checking migration status

To see which migrations have been applied:

```sql
SELECT version, applied_at 
FROM schema_migrations 
ORDER BY applied_at DESC;
```

### Re-running a migration

If a migration was recorded but you need to re-run it:

1. **Remove the record** (development only):

   ```sql
   DELETE FROM schema_migrations WHERE version = '002_your_migration.sql';
   ```

2. **Restart the API** or run `npm run migrate`

⚠️ **Warning**: Only do this in development. In production, create a new migration to fix issues.

---

## Schema vs migrations

### `schema.sql` (legacy)

- **Purpose**: Full schema definition for reference
- **Usage**: Not used directly by the migration system
- **Status**: Kept for documentation; actual schema is in `001_initial_schema.sql`

### `src/db/migrations/`

- **Purpose**: Incremental, tracked schema changes
- **Usage**: Automatically applied by the migration runner
- **Naming**: `XXX_description.sql` (e.g., `002_add_user_preferences.sql`)

### `src/db/runMigrations.js`

- **Purpose**: Automated migration runner
- **Features**:
  - Creates `schema_migrations` table if missing
  - Scans for pending migrations
  - Applies migrations in order
  - Records applied migrations
  - Logs progress

---

## Migration workflow

### For developers

1. **Pull latest code** with new migrations
2. **Start the API**: `npm start`
3. **Migrations run automatically** on startup
4. **Verify**: Check logs for "Applied X migration(s)"

### For new installations

1. **Set up database** and configure `.env`
2. **Start the API**: `npm start`
3. **All migrations run** (including `001_initial_schema.sql`)
4. **Database is ready** with full schema and seed data

### For production deployments

1. **Test migrations** in staging environment
2. **Deploy new code** with migration files
3. **Restart API** to apply migrations
4. **Monitor logs** for successful migration application
5. **Verify database** state after deployment

---

## Related files

- `src/db/runMigrations.js` – Automated migration runner
- `src/db/migrations/` – Migration SQL files
- `src/db/schema.sql` – Legacy full schema (reference only)
- `src/db/pool.js` – Database connection pool
- `src/db/reset.js` – Database reset utility (development)
- `.cursor/rules/migrations.mdc` – Migration conventions and patterns
