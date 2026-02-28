-- OpenRouter model pricing cache
-- Stores per-token costs fetched from the OpenRouter /api/v1/models endpoint.
-- Used to estimate session cost when OpenClaw does not return a totalCost value
-- (e.g. newer models where OpenClaw has no internal pricing data).
--
-- Values are in USD per token (not per million).
-- Refreshed weekly by the modelPricingService background job.

CREATE TABLE IF NOT EXISTS model_pricing (
  model_id                    TEXT PRIMARY KEY,
  model_name                  TEXT,
  prompt_cost_per_token       NUMERIC(18, 12) NOT NULL DEFAULT 0,
  completion_cost_per_token   NUMERIC(18, 12) NOT NULL DEFAULT 0,
  context_length              INTEGER,
  synced_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_pricing_synced_at ON model_pricing (synced_at DESC);
