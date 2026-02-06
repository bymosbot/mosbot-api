-- Add comment-specific event types to task_logs
-- This allows better filtering and clarity in the audit trail

BEGIN;

-- Drop the existing constraint
ALTER TABLE task_logs DROP CONSTRAINT IF EXISTS valid_event_type;

-- Add the new constraint with comment event types
ALTER TABLE task_logs ADD CONSTRAINT valid_event_type CHECK (
    event_type IN (
        'CREATED',
        'UPDATED',
        'STATUS_CHANGED',
        'ARCHIVED_AUTO',
        'ARCHIVED_MANUAL',
        'RESTORED',
        'DELETED',
        'COMMENT_CREATED',
        'COMMENT_UPDATED',
        'COMMENT_DELETED'
    )
);

COMMIT;
