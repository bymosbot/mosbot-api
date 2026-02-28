-- Migration 013: Cleanup duplicate activity logs
-- Fixes duplicate entries caused by missing dedupe_key or duplicate session_keys

-- Step 1: Backfill dedupe_key for entries that have session_key but NULL dedupe_key
-- This ensures all cron/heartbeat runs have proper dedupe_keys
UPDATE activity_logs
SET dedupe_key = 'session:' || session_key
WHERE session_key IS NOT NULL
  AND dedupe_key IS NULL
  AND (
    session_key LIKE 'agent:%:cron:%:run:%'
    OR session_key LIKE 'agent:%:isolated:run:%'
    OR session_key LIKE 'agent:%:heartbeat:run:%'
  );

-- Step 2: Remove duplicate entries with the same dedupe_key
-- Keep the oldest entry (lowest id) for each dedupe_key
-- Note: This shouldn't happen due to the unique index, but clean up if it exists
DELETE FROM activity_logs al1
WHERE al1.dedupe_key IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM activity_logs al2
    WHERE al2.dedupe_key = al1.dedupe_key
      AND al2.id < al1.id
  );

-- Step 3: Remove duplicate entries with the same session_key but different dedupe_keys
-- This can happen if dedupe_key wasn't set correctly during ingestion
-- Keep the oldest entry (lowest id) and ensure it has the correct dedupe_key
DELETE FROM activity_logs al1
WHERE al1.session_key IS NOT NULL
  AND al1.session_key LIKE 'agent:%:cron:%:run:%'
  AND EXISTS (
    SELECT 1 FROM activity_logs al2
    WHERE al2.session_key = al1.session_key
      AND al2.id < al1.id
  );

-- Also clean up isolated/heartbeat duplicates
DELETE FROM activity_logs al1
WHERE al1.session_key IS NOT NULL
  AND (
    al1.session_key LIKE 'agent:%:isolated:run:%'
    OR al1.session_key LIKE 'agent:%:heartbeat:run:%'
  )
  AND EXISTS (
    SELECT 1 FROM activity_logs al2
    WHERE al2.session_key = al1.session_key
      AND al2.id < al1.id
  );
