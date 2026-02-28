-- Standup entries: enforce one entry per agent per standup
-- This makes idempotent re-runs safe and prevents duplicate entries
-- from concurrent cron or manual run invocations.

ALTER TABLE standup_entries
  ADD CONSTRAINT standup_entries_standup_agent_unique
  UNIQUE (standup_id, agent_id);
