-- Add task comments
-- Creates task_comments table to support per-task discussions

BEGIN;

CREATE TABLE IF NOT EXISTS task_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    task_id UUID NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    author_id UUID REFERENCES users (id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT check_body_not_empty CHECK (trim(body) != ''),
    CONSTRAINT check_body_length CHECK (char_length(body) <= 5000)
);

CREATE INDEX IF NOT EXISTS idx_task_comments_task_created
ON task_comments (task_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_task_comments_author_id
ON task_comments (author_id);

-- Triggers for auto-updating updated_at (idempotent)
DROP TRIGGER IF EXISTS update_task_comments_updated_at ON task_comments;

CREATE TRIGGER update_task_comments_updated_at
  BEFORE UPDATE ON task_comments
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

COMMIT;

