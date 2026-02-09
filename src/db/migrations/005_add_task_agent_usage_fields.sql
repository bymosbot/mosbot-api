-- Migration: Add agent usage and cost tracking fields to tasks table
-- These fields store AI model usage metrics and cost per task

BEGIN;

-- Add agent cost in USD
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_cost_usd NUMERIC(12,6);

-- Add agent token usage fields
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_tokens_input INTEGER;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_tokens_input_cache INTEGER;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_tokens_output INTEGER;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_tokens_output_cache INTEGER;

-- Add agent model information
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_model TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_model_provider TEXT;

COMMIT;
