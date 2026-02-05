# Database Migration Guide

## Overview

This guide explains how to run database migrations for the Mosbot API.

## Running Migrations

### Using the Migration Runner

```bash
node src/db/run-migration.js <migration-file>
```

### Example

```bash
node src/db/run-migration.js 001-add-task-id-to-activity-logs.sql
```

## Available Migrations

### 001-add-task-id-to-activity-logs.sql

**Purpose**: Adds the `task_id` foreign key column to the `activity_logs` table.

**When to run**: If you're upgrading from an earlier version where the `activity_logs` table was created without the `task_id` column.

**Symptoms of missing column**:

- 500 error when accessing `/api/v1/tasks/:id/activity`
- Error message: `column "task_id" does not exist`

**What it does**:

- Checks if `task_id` column exists
- Adds `task_id UUID` column with foreign key to `tasks(id)`
- Sets `ON DELETE SET NULL` to handle task deletions gracefully
- Creates an index on `task_id` for better query performance
- Idempotent: Safe to run multiple times

**SQL**:

```sql
ALTER TABLE activity_logs 
ADD COLUMN task_id UUID REFERENCES tasks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_activity_task_id ON activity_logs(task_id);
```

## Creating New Migrations

1. Create a new SQL file in `src/db/migrations/` with a descriptive name:

   ```bash
   XXX-description-of-change.sql
   ```

   Where XXX is a sequential number (e.g., 002, 003, etc.)

2. Write idempotent SQL that checks for existence before making changes:

   ```sql
   DO $$ 
   BEGIN
     IF NOT EXISTS (
       -- Your check here
     ) THEN
       -- Your migration here
       RAISE NOTICE 'Migration applied';
     ELSE
       RAISE NOTICE 'Migration already applied';
     END IF;
   END $$;
   ```

3. Test the migration:

   ```bash
   node src/db/run-migration.js XXX-description-of-change.sql
   ```

4. Run it again to verify idempotency:

   ```bash
   node src/db/run-migration.js XXX-description-of-change.sql
   ```

## Migration Best Practices

### 1. Always Make Migrations Idempotent

Migrations should be safe to run multiple times without causing errors or duplicate changes.

**Good**:

```sql
ALTER TABLE my_table 
ADD COLUMN IF NOT EXISTS new_column VARCHAR(255);
```

**Bad**:

```sql
ALTER TABLE my_table 
ADD COLUMN new_column VARCHAR(255);
-- This will fail on second run
```

### 2. Check for Existence

Use `IF NOT EXISTS` or check `information_schema` before making changes:

```sql
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_name = 'my_table' 
    AND column_name = 'new_column'
  ) THEN
    ALTER TABLE my_table ADD COLUMN new_column VARCHAR(255);
  END IF;
END $$;
```

### 3. Handle Data Migration Carefully

When adding NOT NULL columns to existing tables:

```sql
-- Step 1: Add column as nullable
ALTER TABLE my_table ADD COLUMN new_column VARCHAR(255);

-- Step 2: Populate with default values
UPDATE my_table SET new_column = 'default' WHERE new_column IS NULL;

-- Step 3: Add NOT NULL constraint
ALTER TABLE my_table ALTER COLUMN new_column SET NOT NULL;
```

### 4. Add Indexes for Foreign Keys

Always add indexes on foreign key columns for better performance:

```sql
CREATE INDEX IF NOT EXISTS idx_table_foreign_key 
ON my_table(foreign_key_column);
```

### 5. Use Transactions for Complex Migrations

Wrap complex migrations in transactions:

```sql
BEGIN;

-- Your migration steps here

COMMIT;
```

### 6. Test on a Copy First

Before running on production:

1. Create a database backup
2. Test on a development copy
3. Verify the migration works
4. Verify rollback works (if applicable)

## Troubleshooting

### Error: "SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string"

**Cause**: Environment variables not loaded

**Solution**: The migration runner automatically loads `.env` from the project root. Ensure your `.env` file exists and has correct database credentials.

### Error: "Migration file not found"

**Cause**: Wrong file path or file doesn't exist

**Solution**:

- Check that the migration file exists in `src/db/migrations/`
- Use the filename only, not the full path
- Example: `001-add-task-id-to-activity-logs.sql` (not `src/db/migrations/001-...`)

### Error: "relation 'table_name' does not exist"

**Cause**: Running migration before schema is created

**Solution**:

1. Run the main schema first: `node src/db/migrate.js`
2. Then run your migration

## Schema vs Migrations

### When to use schema.sql

- Initial database setup
- Complete rebuild/reset
- Development environment setup

### When to use migrations

- Production updates
- Adding new features to existing databases
- Modifying existing tables
- Data transformations

## Automated Migration System (Future)

Currently, migrations are run manually. Future improvements could include:

1. **Migration tracking table**:

   ```sql
   CREATE TABLE migrations (
     id SERIAL PRIMARY KEY,
     name VARCHAR(255) UNIQUE NOT NULL,
     applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   );
   ```

2. **Automatic migration runner**:
   - Scans `migrations/` directory
   - Checks which migrations have been applied
   - Runs pending migrations in order
   - Records applied migrations

3. **Rollback support**:
   - Each migration has an "up" and "down" script
   - Ability to rollback to a specific version

## Related Files

- `src/db/schema.sql` - Main database schema
- `src/db/migrate.js` - Schema initialization script
- `src/db/run-migration.js` - Migration runner
- `src/db/migrations/` - Migration files directory
- `src/db/pool.js` - Database connection pool
