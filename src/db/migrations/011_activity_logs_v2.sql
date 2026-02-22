-- Migration 011: Activity Logs v2
-- Adds event_type-based columns to support a unified, DB-backed activity feed.
-- All new columns are nullable or have defaults so existing rows remain valid.

-- Unified event type (replaces the old free-form category)
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS event_type TEXT;

-- Severity level: info | warning | attention | error
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'info';

-- Source domain: task | cron | heartbeat | subagent | workspace | org | standup | system
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'system';

-- Actor (human user who triggered the event, if known)
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Cron / scheduler identifiers
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS job_id TEXT;

-- OpenClaw session key (for Agent Monitor clickthrough)
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS session_key TEXT;

-- Run sub-key extracted from `:run:<id>` suffix
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS run_id TEXT;

-- Workspace path (for workspace / projects file events)
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS workspace_path TEXT;

-- Structured payload (outcome, durations, token counts, diffs, etc.)
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS meta JSONB;

-- Idempotency key for background ingestion pollers
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

-- Backfill: map existing category rows to event_type='legacy' so old entries render gracefully
UPDATE activity_logs
  SET event_type = 'legacy'
  WHERE event_type IS NULL AND category IS NOT NULL;

-- Remaining rows (no category) get a generic 'system' event_type
UPDATE activity_logs
  SET event_type = 'system'
  WHERE event_type IS NULL;

-- Now make event_type NOT NULL with a safe default for future inserts
ALTER TABLE activity_logs ALTER COLUMN event_type SET NOT NULL;
ALTER TABLE activity_logs ALTER COLUMN event_type SET DEFAULT 'system';

-- ============================================================================
-- INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_activity_event_type_ts   ON activity_logs (event_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_source_ts        ON activity_logs (source, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_severity_ts      ON activity_logs (severity, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_job_id           ON activity_logs (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_session_key      ON activity_logs (session_key) WHERE session_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_actor_user_id    ON activity_logs (actor_user_id) WHERE actor_user_id IS NOT NULL;

-- Unique index for deduplication (partial: only rows with a dedupe_key)
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_dedupe_key
  ON activity_logs (dedupe_key)
  WHERE dedupe_key IS NOT NULL;
