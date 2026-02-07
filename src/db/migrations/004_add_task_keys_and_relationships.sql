-- Add task keys, parent/child relationships, and dependencies
-- This enables human-friendly task identifiers (TASK-1234), epic/subtask grouping, and sequential work dependencies

BEGIN;

-- ============================================================================
-- 1. Add task_number column with sequence
-- ============================================================================

-- Create sequence for task numbers
CREATE SEQUENCE IF NOT EXISTS task_number_seq START 1;

-- Add task_number column (nullable initially for backfill)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_number BIGINT;

-- Backfill existing tasks with sequential numbers
UPDATE tasks 
SET task_number = nextval('task_number_seq')
WHERE task_number IS NULL;

-- Make task_number NOT NULL and UNIQUE after backfill
ALTER TABLE tasks ALTER COLUMN task_number SET NOT NULL;
ALTER TABLE tasks ADD CONSTRAINT unique_task_number UNIQUE (task_number);

-- Set sequence to continue from max existing number
SELECT setval('task_number_seq', (SELECT COALESCE(MAX(task_number), 0) FROM tasks));

-- Set default for new tasks
ALTER TABLE tasks ALTER COLUMN task_number SET DEFAULT nextval('task_number_seq');

-- ============================================================================
-- 2. Add parent/child relationship columns
-- ============================================================================

-- Add parent_task_id for epic/subtask relationships
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL;

-- Add sort order for subtasks under the same parent
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_sort_order INTEGER;

-- Prevent task from being its own parent
ALTER TABLE tasks ADD CONSTRAINT check_not_self_parent CHECK (id <> parent_task_id OR parent_task_id IS NULL);

-- Create index for parent lookups
CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id ON tasks(parent_task_id);

-- ============================================================================
-- 3. Extend task type to include 'epic'
-- ============================================================================

-- Drop the existing constraint
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS valid_type;

-- Add the new constraint with 'epic' included
ALTER TABLE tasks ADD CONSTRAINT valid_type CHECK (
    type IN (
        'task',
        'bug',
        'feature',
        'improvement',
        'research',
        'epic'
    )
);

-- ============================================================================
-- 4. Create task_dependencies table
-- ============================================================================

CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (task_id, depends_on_task_id),
    CONSTRAINT check_not_self_dependency CHECK (task_id <> depends_on_task_id)
);

-- Create indexes for both directions of lookup
CREATE INDEX IF NOT EXISTS idx_task_dependencies_task_id ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);

-- ============================================================================
-- 5. Create helper function to check for circular dependencies
-- ============================================================================

-- Function to detect circular dependencies (prevents A->B->C->A cycles)
-- Uses recursive CTE to check all dependency paths, not just the first one
CREATE OR REPLACE FUNCTION check_circular_dependency(p_task_id UUID, p_depends_on_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_has_circular BOOLEAN;
    v_max_depth INTEGER := 100; -- Prevent infinite loops on very deep chains
BEGIN
    -- Use recursive CTE to traverse all dependency paths
    -- Check if any path leads back to p_task_id (which would create a cycle)
    WITH RECURSIVE dependency_chain AS (
        -- Start from the task we want to depend on
        SELECT 
            p_depends_on_id as current_task_id,
            1 as depth,
            ARRAY[p_depends_on_id]::UUID[] as path
        WHERE p_depends_on_id IS NOT NULL
        
        UNION ALL
        
        -- Recursively follow all dependency paths
        SELECT 
            td.depends_on_task_id,
            dc.depth + 1,
            dc.path || td.depends_on_task_id
        FROM dependency_chain dc
        JOIN task_dependencies td ON td.task_id = dc.current_task_id
        WHERE 
            -- Stop if we've seen this task before in this path (cycle detected in this path)
            NOT (td.depends_on_task_id = ANY(dc.path))
            -- Stop if we've exceeded max depth (safety limit)
            AND dc.depth < v_max_depth
            -- Stop if no more dependencies
            AND td.depends_on_task_id IS NOT NULL
            -- Continue recursion until we find p_task_id or exhaust all paths
    )
    SELECT EXISTS (
        SELECT 1 
        FROM dependency_chain 
        WHERE current_task_id = p_task_id
    ) INTO v_has_circular;
    
    RETURN COALESCE(v_has_circular, FALSE);
END;
$$ LANGUAGE plpgsql;

COMMIT;
