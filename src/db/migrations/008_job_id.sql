-- Add job_id to session_usage and session_usage_hourly.
-- job_id is the cron job UUID extracted from the session key:
--   "agent:<agentId>:cron:<jobId>:run:<sessionId>" -> jobId
-- NULL for non-cron sessions (main, subagent, hook, etc.).

ALTER TABLE session_usage
  ADD COLUMN IF NOT EXISTS job_id TEXT,
  ADD COLUMN IF NOT EXISTS label  TEXT;

ALTER TABLE session_usage_hourly
  ADD COLUMN IF NOT EXISTS job_id TEXT;

-- Job breakdown over time
CREATE INDEX IF NOT EXISTS idx_session_usage_hourly_job_bucket
  ON session_usage_hourly (job_id, hour_bucket DESC)
  WHERE job_id IS NOT NULL;

-- Quick per-session job lookup
CREATE INDEX IF NOT EXISTS idx_session_usage_job_id
  ON session_usage (job_id)
  WHERE job_id IS NOT NULL;
