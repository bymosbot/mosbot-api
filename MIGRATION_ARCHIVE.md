# Migration Guide: Archive Feature

This guide explains how to apply the archive feature updates to your existing MosBot installation.

## Overview

The archive feature adds:

- Automatic archiving of DONE tasks after 7 days
- `done_at` and `archived_at` timestamps in the database
- Hidden ARCHIVE column on the kanban dashboard
- Dedicated "Archived" page for viewing archived tasks
- Manual archive/restore actions in the task modal

## Database Migration

### Step 1: Apply Schema Changes

Run the database migration to add the new columns and indexes:

```bash
cd mosbot-api
npm run migrate
```

The schema includes idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements, so it's safe to run multiple times.

### Step 2: Verify Schema Changes

Connect to your database and verify the changes:

```sql
\d tasks
```

You should see:

- `done_at` TIMESTAMP column
- `archived_at` TIMESTAMP column
- Indexes on `done_at` and `(status, done_at)`

## API Updates

### Step 1: Install Dependencies

The archiver uses `node-cron` for scheduling:

```bash
cd mosbot-api
npm install
```

### Step 2: Configure Environment Variables

Add these optional variables to your `.env` file:

```bash
# Archive Job Configuration (all optional with sensible defaults)
ENABLE_ARCHIVER=true           # Enable/disable the scheduler
ARCHIVE_CRON=0 3 * * *         # Cron schedule (default: 3 AM daily)
ARCHIVE_AFTER_DAYS=7           # Days before archiving DONE tasks
ARCHIVE_ON_STARTUP=false       # Run archiver immediately on startup (for testing)
```

### Step 3: Restart API Server

```bash
npm run dev  # development
# or
npm start    # production
```

You should see log messages indicating the archiver is enabled:

```
⏰ Archive scheduler enabled (cron: 0 3 * * *, after 7 days)
```

## Dashboard Updates

### Step 1: Install Dependencies (if needed)

```bash
cd mosbot-dashboard
npm install
```

### Step 2: Restart Development Server

```bash
npm run dev
```

### Step 3: Verify Changes

1. **Kanban Board**: The ARCHIVE column should no longer appear
2. **Sidebar**: A new "Archived" navigation item should appear
3. **Task Modal**:
   - "Archive Task" button appears when viewing DONE tasks
   - "Restore Task" button appears when viewing ARCHIVE tasks
   - ARCHIVE status removed from the status dropdown

## Behavior Changes

### Default Task List

The `/api/v1/tasks` endpoint now **excludes archived tasks by default**.

To include archived tasks:

```
GET /api/v1/tasks?include_archived=true
```

To get only archived tasks:

```
GET /api/v1/tasks?status=ARCHIVE
```

### Status Transitions

When a task's status changes, the API automatically manages timestamps:

| Transition | Action |
|------------|--------|
| → DONE | Sets `done_at = NOW()` |
| DONE → other | Clears `done_at = NULL` |
| → ARCHIVE | Sets `archived_at = NOW()` |
| ARCHIVE → other | Clears `archived_at = NULL` |

### Automatic Archiving

The scheduler runs based on your `ARCHIVE_CRON` setting (default: daily at 3 AM).

It archives tasks where:

- `status = 'DONE'`
- `done_at IS NOT NULL`
- `done_at` is older than `ARCHIVE_AFTER_DAYS` (default: 7 days)

## Testing the Archive Feature

### Manual Testing

1. **Create a test task** and move it to DONE
2. **Verify `done_at` is set** (check via database or API)
3. **Manually archive** via the "Archive Task" button in the modal
4. **View archived tasks** in the new "Archived" page
5. **Restore the task** using the "Restore Task" button
6. Verify the task appears back in the DONE column

### Testing the Scheduler

To test the archiver without waiting 7 days:

1. Set `ARCHIVE_AFTER_DAYS=0` in your `.env`
2. Set `ARCHIVE_ON_STARTUP=true` to run immediately
3. Restart the API
4. Check logs for archive job output

Or manually trigger:

```bash
# In the API directory
node -e "require('./src/jobs/archiveDoneTasks')().then(count => console.log('Archived:', count))"
```

## Multi-Instance Deployments

The archiver uses Postgres advisory locks to ensure only one instance runs at a time, making it safe for:

- Kubernetes deployments with multiple replicas
- Load-balanced API servers
- High-availability setups

The lock ID is `123456789`. If the lock is already held, the job will skip with:

```
⏭️  Archive job already running on another instance, skipping...
```

## Rollback

If you need to rollback:

### Database

```sql
ALTER TABLE tasks DROP COLUMN IF EXISTS done_at;
ALTER TABLE tasks DROP COLUMN IF EXISTS archived_at;
DROP INDEX IF EXISTS idx_tasks_done_at;
DROP INDEX IF EXISTS idx_tasks_status_done_at;
```

### Code

Use git to revert changes:

```bash
cd mosbot-api
git checkout HEAD~1 -- src/

cd mosbot-dashboard
git checkout HEAD~1 -- src/
```

## Troubleshooting

### "Archive job already running" repeatedly

Check for stale locks:

```sql
SELECT * FROM pg_locks WHERE locktype = 'advisory';
-- If stuck, manually release:
SELECT pg_advisory_unlock_all();
```

### Archived tasks not appearing

Check the archived page URL: `http://localhost:5173/archived`
Verify API response: `curl http://localhost:3000/api/v1/tasks?status=ARCHIVE`

### Scheduler not running

- Verify `ENABLE_ARCHIVER=true` in `.env`
- Check API logs on startup for archiver messages
- Verify cron syntax is valid: <https://crontab.guru/>

## Support

For issues or questions, please refer to the main README or open an issue on GitHub.
