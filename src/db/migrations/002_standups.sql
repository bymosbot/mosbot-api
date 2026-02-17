-- Standups migration
-- Creates tables for daily standup meetings where agents report yesterday/today/blockers

-- ============================================================================
-- TABLES
-- ============================================================================

-- Main standups table - one record per day
CREATE TABLE IF NOT EXISTS standups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    standup_date DATE NOT NULL UNIQUE,
    title TEXT NOT NULL,
    timezone TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'error')),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for efficient date lookups
CREATE INDEX IF NOT EXISTS idx_standups_date ON standups(standup_date DESC);
CREATE INDEX IF NOT EXISTS idx_standups_status ON standups(status);

-- Standup entries - one per agent per standup
CREATE TABLE IF NOT EXISTS standup_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    standup_id UUID NOT NULL REFERENCES standups(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    agent_icon TEXT,
    turn_order INTEGER NOT NULL,
    yesterday TEXT,
    today TEXT,
    blockers TEXT,
    tasks JSONB,
    raw TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for efficient standup lookups
CREATE INDEX IF NOT EXISTS idx_standup_entries_standup_id ON standup_entries(standup_id);
CREATE INDEX IF NOT EXISTS idx_standup_entries_turn_order ON standup_entries(standup_id, turn_order);

-- Standup messages - transcript for UI rendering
CREATE TABLE IF NOT EXISTS standup_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    standup_id UUID NOT NULL REFERENCES standups(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('system', 'agent')),
    agent_id TEXT,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for efficient message retrieval
CREATE INDEX IF NOT EXISTS idx_standup_messages_standup_id ON standup_messages(standup_id, created_at);

-- ============================================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_standups_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update updated_at
CREATE TRIGGER standups_updated_at_trigger
    BEFORE UPDATE ON standups
    FOR EACH ROW
    EXECUTE FUNCTION update_standups_updated_at();

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE standups IS 'Daily standup meetings where agents report their progress';
COMMENT ON COLUMN standups.standup_date IS 'Date of the standup (one per day, unique)';
COMMENT ON COLUMN standups.timezone IS 'Timezone used when generating this standup';
COMMENT ON COLUMN standups.status IS 'Status: running, completed, or error';

COMMENT ON TABLE standup_entries IS 'Individual agent reports within a standup';
COMMENT ON COLUMN standup_entries.turn_order IS 'Order in which the agent spoke (1, 2, 3...)';
COMMENT ON COLUMN standup_entries.yesterday IS 'What the agent worked on yesterday';
COMMENT ON COLUMN standup_entries.today IS 'What the agent plans to work on today';
COMMENT ON COLUMN standup_entries.blockers IS 'Any blockers or issues to surface';
COMMENT ON COLUMN standup_entries.tasks IS 'Structured task/issue data (optional)';
COMMENT ON COLUMN standup_entries.raw IS 'Full raw response from the agent';

COMMENT ON TABLE standup_messages IS 'Transcript messages for UI rendering (system announcements + agent responses)';
COMMENT ON COLUMN standup_messages.kind IS 'Message type: system or agent';
