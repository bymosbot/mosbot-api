-- Time-bucketed session usage for time-series graphs and breakdowns.
-- Stores incremental (delta) usage per session per hour bucket.
-- Each upsert accumulates deltas within the same hour so the poller
-- can run every 60s without creating duplicate rows.
--
-- Deltas are computed by the application layer:
--   delta = new_cumulative (from Gateway) - old_cumulative (from session_usage)
-- This table is the primary source for:
--   - Hourly / daily cost graphs
--   - Per-agent and per-model breakdowns over time
--   - Per-session drill-down within a time range

CREATE TABLE IF NOT EXISTS session_usage_hourly (
  session_key        TEXT NOT NULL,
  agent_key          TEXT NOT NULL,
  model              TEXT,
  hour_bucket        TIMESTAMPTZ NOT NULL,
  tokens_input       INTEGER NOT NULL DEFAULT 0,
  tokens_output      INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read  INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd           NUMERIC(12, 6) NOT NULL DEFAULT 0,
  PRIMARY KEY (session_key, hour_bucket)
);

-- Time-range scans (most common: "last N hours/days")
CREATE INDEX IF NOT EXISTS idx_session_usage_hourly_bucket
  ON session_usage_hourly (hour_bucket DESC);

-- Agent breakdown over time
CREATE INDEX IF NOT EXISTS idx_session_usage_hourly_agent_bucket
  ON session_usage_hourly (agent_key, hour_bucket DESC);

-- Model breakdown over time
CREATE INDEX IF NOT EXISTS idx_session_usage_hourly_model_bucket
  ON session_usage_hourly (model, hour_bucket DESC);
