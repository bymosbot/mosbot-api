-- Migration: Add preferred model field to tasks table
-- This field stores the user's selected/preferred AI model for task execution
-- Provider is automatically determined from the model name using the models config
-- Separate from agent_model/agent_model_provider which track actual usage

BEGIN;

-- Add preferred model field (nullable = use system default)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS preferred_model TEXT;

COMMIT;
