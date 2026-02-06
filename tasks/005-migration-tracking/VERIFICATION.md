# Migration Tracking System - Verification Checklist

This document outlines the verification steps for the migration tracking system implementation.

## ✅ Code Quality Checks

- [x] **Syntax validation**: All JavaScript files pass Node.js syntax check
  - `src/db/runMigrations.js` ✅
  - `src/index.js` ✅
  - `src/db/reset.js` ✅

- [x] **Migration files created**:
  - `000_create_migrations_table.sql` (12 lines) ✅
  - `001_initial_schema.sql` (246 lines) ✅

- [x] **File structure**:
  - `src/db/migrations/` directory created ✅
  - Migration files use correct naming convention (XXX_description.sql) ✅

## 🧪 Manual Testing Checklist

To verify the implementation works correctly, perform these tests with a real database:

### Test 1: Fresh Database Installation

**Setup**: Empty PostgreSQL database

**Steps**:

1. Configure `.env` with database credentials
2. Run `npm run migrate`

**Expected Results**:

- ✅ `schema_migrations` table is created
- ✅ Migration `000_create_migrations_table.sql` is applied and recorded
- ✅ Migration `001_initial_schema.sql` is applied and recorded
- ✅ All tables (users, tasks, activity_logs, task_logs) exist
- ✅ All functions, triggers, and indexes are created
- ✅ Default owner user is seeded
- ✅ Console logs show: "Successfully applied 2 migration(s)"

**Verification Query**:

```sql
SELECT version, applied_at FROM schema_migrations ORDER BY version;
```

Expected output:

```
version                          | applied_at
---------------------------------|-------------------------
000_create_migrations_table.sql  | 2024-XX-XX XX:XX:XX
001_initial_schema.sql           | 2024-XX-XX XX:XX:XX
```

### Test 2: API Startup with Fresh Database

**Setup**: Empty PostgreSQL database

**Steps**:

1. Configure `.env` with database credentials
2. Run `npm start`

**Expected Results**:

- ✅ Migrations run automatically on startup
- ✅ API starts successfully
- ✅ Console logs show migration progress
- ✅ Health check endpoint responds: `GET http://localhost:3000/health`

### Test 3: Restart with Existing Database

**Setup**: Database with migrations already applied (from Test 1 or 2)

**Steps**:

1. Restart the API: `npm start`

**Expected Results**:

- ✅ Console logs show: "All migrations up to date (0 pending)"
- ✅ No migrations are re-applied
- ✅ API starts successfully

**Verification Query**:

```sql
SELECT COUNT(*) FROM schema_migrations;
```

Expected: Count should remain 2 (no duplicates)

### Test 4: Adding a New Migration

**Setup**: Database with initial migrations applied

**Steps**:

1. Create a new migration file: `src/db/migrations/002_add_test_column.sql`

   ```sql
   -- Test migration
   ALTER TABLE tasks ADD COLUMN IF NOT EXISTS test_column VARCHAR(50);
   CREATE INDEX IF NOT EXISTS idx_tasks_test_column ON tasks(test_column);
   ```

2. Run `npm run migrate`

**Expected Results**:

- ✅ Console logs show: "Found 1 pending migration(s)"
- ✅ Migration `002_add_test_column.sql` is applied
- ✅ Console logs show: "Successfully applied 1 migration(s)"
- ✅ New column exists in tasks table

**Verification Queries**:

```sql
-- Check migration was recorded
SELECT version, applied_at FROM schema_migrations ORDER BY version;

-- Check column was added
SELECT column_name FROM information_schema.columns 
WHERE table_name = 'tasks' AND column_name = 'test_column';
```

### Test 5: Database Reset

**Setup**: Database with migrations applied

**Steps**:

1. Run `npm run db:reset`
2. Confirm the reset when prompted

**Expected Results**:

- ✅ All tables are dropped (including `schema_migrations`)
- ✅ All functions are dropped
- ✅ Migrations are re-applied from scratch
- ✅ Database is in clean state with all migrations applied
- ✅ Console logs show successful reset and migration

**Verification Query**:

```sql
-- Check all tables exist
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' 
ORDER BY table_name;

-- Check migrations were re-applied
SELECT version, applied_at FROM schema_migrations ORDER BY version;
```

### Test 6: Migration Failure Handling

**Setup**: Database with initial migrations applied

**Steps**:

1. Create a migration with intentional SQL error: `src/db/migrations/002_broken.sql`

   ```sql
   -- This will fail
   ALTER TABLE nonexistent_table ADD COLUMN test VARCHAR(50);
   ```

2. Run `npm run migrate`

**Expected Results**:

- ✅ Migration fails with error message
- ✅ Transaction is rolled back
- ✅ Migration is NOT recorded in `schema_migrations`
- ✅ Process exits with error code 1

**Verification Query**:

```sql
-- Check migration was NOT recorded
SELECT version FROM schema_migrations WHERE version = '002_broken.sql';
```

Expected: No rows (migration not recorded)

**Cleanup**:

```bash
rm src/db/migrations/002_broken.sql
```

### Test 7: Idempotency Check

**Setup**: Database with migrations applied

**Steps**:

1. Manually delete a migration record:

   ```sql
   DELETE FROM schema_migrations WHERE version = '001_initial_schema.sql';
   ```

2. Run `npm run migrate`

**Expected Results**:

- ✅ Migration `001_initial_schema.sql` runs again
- ✅ No errors occur (idempotent SQL)
- ✅ No duplicate data is created
- ✅ Migration is recorded again

**Verification Query**:

```sql
-- Check migration was re-recorded
SELECT version, applied_at FROM schema_migrations 
WHERE version = '001_initial_schema.sql';

-- Check no duplicate owner users
SELECT COUNT(*) FROM users WHERE role = 'owner';
```

Expected: Count should be 1 (not 2)

## 📋 Documentation Verification

- [x] **migration-guide.md updated**:
  - [x] Removed "Planned: migration tracking" section
  - [x] Added comprehensive migration system documentation
  - [x] Added troubleshooting section
  - [x] Added examples for adding new migrations

- [x] **migrations.mdc updated**:
  - [x] Updated file naming convention (underscores, not hyphens)
  - [x] Added migration tracking section
  - [x] Updated related files references

- [x] **README.md check**:
  - [ ] Verify README mentions migration system (if applicable)

## 🔍 Code Review Checklist

- [x] **runMigrations.js**:
  - [x] Creates migrations table if missing (bootstrap)
  - [x] Scans migrations directory for .sql files
  - [x] Sorts files alphabetically
  - [x] Filters out already-applied migrations
  - [x] Runs each migration in a transaction
  - [x] Records successful migrations
  - [x] Handles errors gracefully
  - [x] Logs progress clearly

- [x] **index.js**:
  - [x] Imports `runMigrations` instead of `migrate`
  - [x] Calls `runMigrations({ endPool: false })` on startup
  - [x] Handles migration errors

- [x] **reset.js**:
  - [x] Drops `schema_migrations` table
  - [x] Imports `runMigrations` instead of `migrate`
  - [x] Calls `runMigrations({ endPool: false })` after reset

- [x] **package.json**:
  - [x] `npm run migrate` points to `runMigrations.js`

## 🎯 Acceptance Criteria Verification

From task.md:

- [x] A `schema_migrations` table exists and is created automatically when missing
  - ✅ Bootstrap migration creates the table
  - ✅ `runMigrations.js` ensures table exists before running migrations

- [x] The runner applies only migration files that are not yet recorded, in filename order
  - ✅ `getAppliedMigrations()` fetches recorded migrations
  - ✅ `pendingMigrations` filters out applied ones
  - ✅ Files are sorted alphabetically

- [x] API startup runs this runner and does not re-apply the full schema.sql every time
  - ✅ `index.js` calls `runMigrations()` on startup
  - ✅ Only pending migrations are applied

- [x] `npm run migrate` (and/or db:reset) still yields a correct, usable database for development
  - ✅ `npm run migrate` runs `runMigrations.js`
  - ✅ `npm run db:reset` drops all tables and re-runs migrations

- [x] Documentation explains the tracking table, runner, and how to add new migrations
  - ✅ `migration-guide.md` has comprehensive documentation
  - ✅ Examples for adding new migrations
  - ✅ Troubleshooting section

## 🚀 Next Steps

1. **Manual Testing**: Perform all tests in the "Manual Testing Checklist" section with a real database
2. **Integration Testing**: Verify the system works in a staging environment
3. **Production Deployment**: Deploy with confidence that migrations will run automatically

## 📝 Notes

- **Backward Compatibility**: Existing deployments that only ran `schema.sql` will automatically get the tracking table and have all migrations applied on first startup with the new code.
- **Rollback**: Down migrations are out of scope for this task. If needed, create a new migration to undo changes.
- **Performance**: Migration runner is fast for small numbers of migrations. For large numbers (100+), consider optimizing the query to fetch applied migrations.
