-- Migration 010: Add agent_id column to activity_logs
-- Allows activity log entries to be attributed to a specific OpenClaw agent (e.g. "mochi")

ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS agent_id VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_activity_agent_id ON activity_logs(agent_id);
