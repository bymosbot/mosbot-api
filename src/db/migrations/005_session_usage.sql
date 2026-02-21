-- Session usage tracking
-- Stores cumulative token and cost totals per session, updated continuously
-- while the session is live. Each upsert replaces the previous totals because
-- the Gateway returns running cumulative sums, not deltas.

CREATE TABLE IF NOT EXISTS session_usage (
  session_key        TEXT PRIMARY KEY,
  agent_key          TEXT,
  model              TEXT,
  tokens_input       INTEGER NOT NULL DEFAULT 0,
  tokens_output      INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read  INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd           NUMERIC(12, 6) NOT NULL DEFAULT 0,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_usage_agent_key ON session_usage (agent_key);
CREATE INDEX IF NOT EXISTS idx_session_usage_last_updated ON session_usage (last_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_usage_first_seen ON session_usage (first_seen_at DESC);
