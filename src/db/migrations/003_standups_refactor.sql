-- Standup entries refactor
-- References users table directly; removes redundant agent_name and agent_icon columns

ALTER TABLE standup_entries
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE standup_entries
  DROP COLUMN IF EXISTS agent_name,
  DROP COLUMN IF EXISTS agent_icon;

CREATE INDEX IF NOT EXISTS idx_standup_entries_user_id ON standup_entries(user_id);
