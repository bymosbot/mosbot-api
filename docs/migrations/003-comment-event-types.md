# Migration 003: Add Comment Event Types

## Overview

This migration adds dedicated event types for comment operations to the `task_logs` table, improving clarity and enabling better filtering of audit logs.

## Changes

### Before (Migration 002)

Comment events were logged as generic `'UPDATED'` events with action details in the `meta` field:

```sql
-- task_logs constraint
CONSTRAINT valid_event_type CHECK (
    event_type IN (
        'CREATED',
        'UPDATED',
        'STATUS_CHANGED',
        'ARCHIVED_AUTO',
        'ARCHIVED_MANUAL',
        'RESTORED',
        'DELETED'
    )
)
```

**Example log entry:**

```json
{
  "event_type": "UPDATED",
  "meta": {
    "action": "comment_created",
    "comment_id": "uuid",
    "comment_body": "Comment text"
  }
}
```

### After (Migration 003)

Comment events have dedicated event types:

```sql
-- Updated task_logs constraint
CONSTRAINT valid_event_type CHECK (
    event_type IN (
        'CREATED',
        'UPDATED',
        'STATUS_CHANGED',
        'ARCHIVED_AUTO',
        'ARCHIVED_MANUAL',
        'RESTORED',
        'DELETED',
        'COMMENT_CREATED',    -- NEW
        'COMMENT_UPDATED',    -- NEW
        'COMMENT_DELETED'     -- NEW
    )
)
```

**Example log entry:**

```json
{
  "event_type": "COMMENT_CREATED",
  "meta": {
    "comment_id": "uuid",
    "comment_body": "Comment text"
  }
}
```

## Benefits

1. **Better Clarity**: Event type clearly indicates comment operations
2. **Easier Filtering**: Can filter history by `event_type` without parsing `meta`
3. **Consistent Pattern**: Follows existing pattern of dedicated event types
4. **Improved UX**: Frontend can display proper icons/labels based on event type alone

## Migration Details

**File:** `src/db/migrations/003_add_comment_event_types.sql`

**Operations:**

1. Drop existing `valid_event_type` constraint
2. Add new constraint with comment event types

**Idempotency:** Safe to run multiple times (uses `IF EXISTS`)

**Rollback:** Not recommended - would break existing comment logs

## Code Changes

### Backend (mosbot-api)

**src/routes/tasks.js:**

- Changed `'UPDATED'` → `'COMMENT_CREATED'` for comment creation
- Changed `'UPDATED'` → `'COMMENT_UPDATED'` for comment updates
- Changed `'UPDATED'` → `'COMMENT_DELETED'` for comment deletion
- Removed `action` field from `meta` (no longer needed)

### Frontend (mosbot-dashboard)

**src/components/TaskModal.jsx:**

- Updated `getEventIcon()` to check `event_type` instead of `meta.action`
- Updated `getEventColor()` to check `event_type` instead of `meta.action`
- Updated `getEventLabel()` to check `event_type` instead of `meta.action`
- Updated `formatHistoryEntry()` to check `event_type` instead of `meta.action`

## Running the Migration

```bash
# In mosbot-api directory
npm run migrate
```

The migration will:

1. Check for existing constraint
2. Drop it if found
3. Add new constraint with comment event types
4. Commit changes

**Note:** Existing logs with `event_type='UPDATED'` and `meta.action='comment_*'` will still be valid but should be manually updated if needed.

## Testing

All existing tests pass with the new event types:

- ✅ 15 unit tests for comment endpoints
- ✅ Authorization checks
- ✅ Audit logging verification

## Backward Compatibility

**Breaking Change:** Frontend code that checks `meta.action` will need to be updated to check `event_type` instead.

**Migration Path:**

1. Apply database migration (003)
2. Deploy backend changes (uses new event types)
3. Deploy frontend changes (reads new event types)

**Old logs:** Frontend can handle both old (`meta.action`) and new (`event_type`) formats by checking both fields.

## Future Considerations

If you need to query comment events from the database:

```sql
-- Get all comment events for a task
SELECT * FROM task_logs 
WHERE task_id = 'uuid' 
AND event_type IN ('COMMENT_CREATED', 'COMMENT_UPDATED', 'COMMENT_DELETED')
ORDER BY occurred_at DESC;

-- Count comments by type
SELECT event_type, COUNT(*) 
FROM task_logs 
WHERE event_type LIKE 'COMMENT_%'
GROUP BY event_type;
```
