-- Migration: Add tasks.description column (markdown longform)
-- Moves existing tasks.summary content -> tasks.description
-- tasks.summary remains as a short plain-text field; description is the markdown body

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT;

-- Backfill: move existing summary content into description
UPDATE tasks SET description = summary WHERE summary IS NOT NULL AND summary != '';

-- Clear summary so it is no longer used as the markdown body
UPDATE tasks SET summary = NULL WHERE summary IS NOT NULL;
