-- Add label to session_usage if missing.
-- Migration 008 added job_id and label together; some DBs may have 008 applied
-- but lack label (e.g. 008 ran before label was added, or DB restored from backup).

ALTER TABLE session_usage
  ADD COLUMN IF NOT EXISTS label TEXT;
