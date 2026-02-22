-- Initial schema migration
-- This migration creates all tables, functions, triggers, and seed data for a fresh database

-- ============================================================================
-- VALIDATION FUNCTIONS
-- ============================================================================

-- Function: Validate that all tags are 50 characters or less
CREATE OR REPLACE FUNCTION validate_tags_length(tags TEXT[])
RETURNS BOOLEAN AS $$
BEGIN
  IF tags IS NULL THEN
    RETURN TRUE;
  END IF;
  
  FOR i IN 1..array_length(tags, 1) LOOP
    IF length(tags[i]) > 50 THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function: Validate that all tags are lowercase
CREATE OR REPLACE FUNCTION validate_tags_lowercase(tags TEXT[])
RETURNS BOOLEAN AS $$
BEGIN
  IF tags IS NULL THEN
    RETURN TRUE;
  END IF;
  
  FOR i IN 1..array_length(tags, 1) LOOP
    IF tags[i] != lower(tags[i]) THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function: Validate that no tags are empty
CREATE OR REPLACE FUNCTION validate_tags_not_empty(tags TEXT[])
RETURNS BOOLEAN AS $$
BEGIN
  IF tags IS NULL THEN
    RETURN TRUE;
  END IF;
  
  FOR i IN 1..array_length(tags, 1) LOOP
    IF trim(tags[i]) = '' THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================================
-- SEQUENCES
-- ============================================================================

-- Sequence for task numbers (TASK-1, TASK-2, etc.)
CREATE SEQUENCE IF NOT EXISTS task_number_seq START 1;

-- ============================================================================
-- TABLES
-- ============================================================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    avatar_url TEXT,
    role VARCHAR(20) DEFAULT 'user',
    agent_id TEXT UNIQUE,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT valid_role CHECK (
        role IN ('owner', 'agent', 'admin', 'user')
    ),
    CONSTRAINT check_email_format CHECK (
        email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
    ),
    CONSTRAINT check_name_not_empty CHECK (trim(name) != ''),
    CONSTRAINT check_agent_role_requires_agent_id CHECK (
        (role = 'agent' AND agent_id IS NOT NULL) OR
        (role != 'agent')
    ),
    CONSTRAINT check_agent_id_format CHECK (
        agent_id IS NULL OR 
        agent_id ~ '^[a-z0-9_-]+$'
    )
);

-- Tasks table (consolidated with all features)
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_number BIGINT NOT NULL UNIQUE DEFAULT nextval('task_number_seq'),
  title VARCHAR(500) NOT NULL,
  summary TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'PLANNING',
  priority VARCHAR(50),
  type VARCHAR(50) DEFAULT 'task',
  reporter_id UUID REFERENCES users(id) ON DELETE SET NULL,
  assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  tags TEXT[],
  due_date TIMESTAMP,
  done_at TIMESTAMP,
  archived_at TIMESTAMP,
  parent_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  parent_sort_order INTEGER,
  agent_cost_usd NUMERIC(12,6),
  agent_tokens_input INTEGER,
  agent_tokens_input_cache INTEGER,
  agent_tokens_output INTEGER,
  agent_tokens_output_cache INTEGER,
  agent_model TEXT,
  agent_model_provider TEXT,
  preferred_model TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

-- Basic validation constraints
CONSTRAINT valid_status CHECK (
    status IN (
        'PLANNING',
        'TO DO',
        'IN PROGRESS',
        'DONE',
        'ARCHIVE'
    )
),
CONSTRAINT valid_priority CHECK (
    priority IN ('High', 'Medium', 'Low')
    OR priority IS NULL
),
CONSTRAINT valid_type CHECK (
    type IN (
        'task',
        'bug',
        'feature',
        'improvement',
        'research',
        'epic'
    )
),
CONSTRAINT check_not_self_parent CHECK (id <> parent_task_id OR parent_task_id IS NULL),

-- Tags validation constraints
CONSTRAINT check_tags_array_length CHECK (
    tags IS NULL
    OR array_length (tags, 1) IS NULL
    OR array_length (tags, 1) <= 20
),
CONSTRAINT check_tags_element_length CHECK (validate_tags_length (tags)),
CONSTRAINT check_tags_lowercase CHECK (
    validate_tags_lowercase (tags)
),
CONSTRAINT check_tags_not_empty CHECK (
    validate_tags_not_empty (tags)
),

-- Status and timestamp consistency
CONSTRAINT check_done_at_with_status CHECK (
    (
        status = 'DONE'
        AND done_at IS NOT NULL
    )
    OR (
        status != 'DONE'
        AND done_at IS NULL
    )
),
CONSTRAINT check_archived_at_with_status CHECK (
    (
        status = 'ARCHIVE'
        AND archived_at IS NOT NULL
    )
    OR (
        status != 'ARCHIVE'
        AND archived_at IS NULL
    )
),

-- Date range validation
CONSTRAINT check_done_at_after_created CHECK (
    done_at IS NULL OR
    done_at >= created_at
  ),
  CONSTRAINT check_archived_at_after_created CHECK (
    archived_at IS NULL OR
    archived_at >= created_at
  ),
  CONSTRAINT check_due_date_reasonable CHECK (
    due_date IS NULL OR
    due_date >= '2020-01-01'::timestamp
  ),

-- String validation
CONSTRAINT check_title_not_empty CHECK (trim(title) != '') );

-- Activity logs table
CREATE TABLE IF NOT EXISTS activity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    title VARCHAR(500) NOT NULL,
    description TEXT NOT NULL,
    -- Legacy free-form category (kept for backward compat; new code uses event_type)
    category VARCHAR(100),
    task_id UUID REFERENCES tasks (id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- v2 unified event taxonomy
    event_type TEXT NOT NULL DEFAULT 'system',
    severity TEXT NOT NULL DEFAULT 'info',
    source TEXT NOT NULL DEFAULT 'system',
    actor_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
    agent_id VARCHAR(100),
    job_id TEXT,
    session_key TEXT,
    run_id TEXT,
    workspace_path TEXT,
    meta JSONB,
    dedupe_key TEXT
);

-- Task logs table (per-task history/audit trail)
CREATE TABLE IF NOT EXISTS task_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    task_id UUID NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    actor_id UUID REFERENCES users (id) ON DELETE SET NULL,
    source VARCHAR(20) NOT NULL,
    old_values JSONB,
    new_values JSONB,
    meta JSONB,
    CONSTRAINT valid_event_type CHECK (
        event_type IN (
            'CREATED',
            'UPDATED',
            'STATUS_CHANGED',
            'ARCHIVED_AUTO',
            'ARCHIVED_MANUAL',
            'RESTORED',
            'DELETED',
            'COMMENT_CREATED',
            'COMMENT_UPDATED',
            'COMMENT_DELETED'
        )
    ),
    CONSTRAINT valid_source CHECK (
        source IN ('ui', 'api', 'cron', 'system')
    )
);

-- Task comments table
CREATE TABLE IF NOT EXISTS task_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    task_id UUID NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    author_id UUID REFERENCES users (id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT check_body_not_empty CHECK (trim(body) != ''),
    CONSTRAINT check_body_length CHECK (char_length(body) <= 5000)
);

-- Task dependencies table (for blocking relationships)
CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (task_id, depends_on_task_id),
    CONSTRAINT check_not_self_dependency CHECK (task_id <> depends_on_task_id)
);

-- ============================================================================
-- INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

CREATE INDEX IF NOT EXISTS idx_users_active ON users (active);

CREATE INDEX IF NOT EXISTS idx_users_agent_id ON users (agent_id);

-- Enforce exactly one owner (partial unique index)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_owner ON users (role)
WHERE
    role = 'owner';

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);

CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);

CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks (assignee_id);

CREATE INDEX IF NOT EXISTS idx_tasks_reporter ON tasks (reporter_id);

CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_done_at ON tasks (done_at);

CREATE INDEX IF NOT EXISTS idx_tasks_status_done_at ON tasks (status, done_at);

CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id ON tasks(parent_task_id);

CREATE INDEX IF NOT EXISTS idx_task_comments_task_created ON task_comments (task_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_task_comments_author_id ON task_comments (author_id);

CREATE INDEX IF NOT EXISTS idx_task_dependencies_task_id ON task_dependencies(task_id);

CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);

CREATE INDEX IF NOT EXISTS idx_tasks_tags ON tasks USING GIN (tags);

CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_logs (timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_activity_task_id ON activity_logs (task_id);

CREATE INDEX IF NOT EXISTS idx_activity_event_type_ts  ON activity_logs (event_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_source_ts       ON activity_logs (source, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_severity_ts     ON activity_logs (severity, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_agent_id_ts     ON activity_logs (agent_id, timestamp DESC) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_job_id          ON activity_logs (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_session_key     ON activity_logs (session_key) WHERE session_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_actor_user_id   ON activity_logs (actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_dedupe_key ON activity_logs (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_logs_task_occurred ON task_logs (task_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_logs_actor_occurred ON task_logs (actor_id, occurred_at DESC);

-- ============================================================================
-- TRIGGERS AND FUNCTIONS
-- ============================================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for auto-updating updated_at (idempotent)
DROP TRIGGER IF EXISTS update_users_updated_at ON users;

CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_tasks_updated_at ON tasks;

CREATE TRIGGER update_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_task_comments_updated_at ON task_comments;

CREATE TRIGGER update_task_comments_updated_at
  BEFORE UPDATE ON task_comments
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Function to detect circular dependencies (prevents A->B->C->A cycles)
CREATE OR REPLACE FUNCTION check_circular_dependency(p_task_id UUID, p_depends_on_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_has_circular BOOLEAN;
    v_max_depth INTEGER := 100;
BEGIN
    WITH RECURSIVE dependency_chain AS (
        SELECT 
            p_depends_on_id as current_task_id,
            1 as depth,
            ARRAY[p_depends_on_id]::UUID[] as path
        WHERE p_depends_on_id IS NOT NULL
        
        UNION ALL
        
        SELECT 
            td.depends_on_task_id,
            dc.depth + 1,
            dc.path || td.depends_on_task_id
        FROM dependency_chain dc
        JOIN task_dependencies td ON td.task_id = dc.current_task_id
        WHERE 
            NOT (td.depends_on_task_id = ANY(dc.path))
            AND dc.depth < v_max_depth
            AND td.depends_on_task_id IS NOT NULL
    )
    SELECT EXISTS (
        SELECT 1 
        FROM dependency_chain 
        WHERE current_task_id = p_task_id
    ) INTO v_has_circular;
    
    RETURN COALESCE(v_has_circular, FALSE);
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- SEED DATA
-- ============================================================================

-- Seed organization users based on org chart
-- CEO password: admin123 (for owner access)
-- Agent passwords: Auto-generated secure random strings (logged to console during migration)
-- IMPORTANT: Change CEO password after first login!

-- CEO (Owner/Human)
-- Password: admin123 (fixed for easy owner access)
INSERT INTO
    users (
        name,
        email,
        password_hash,
        role,
        avatar_url,
        active
    )
VALUES (
        'Marcelo Oliveira',
        'ceo@mosbot.local',
        '$2b$10$ZnnKYOAALphdWkfm39Bao.fiCpXswsfcOjPqiUNwmfcrEGGiC5hrW',
        'owner',
        null,
        true
    ) ON CONFLICT (email) DO NOTHING;

-- Agent users with placeholder passwords (will be updated by post-migration script)
-- These are created with a temporary hash that will be replaced
-- AI agents use 'agent' role to distinguish from human admins
-- agent_id links to their OpenClaw agent configuration
INSERT INTO
    users (name, email, password_hash, role, agent_id, avatar_url, active)
VALUES 
    ('MosBot', 'coo@mosbot.local', 'PLACEHOLDER', 'agent', 'coo', null, true),
    ('Elon', 'cto@mosbot.local', 'PLACEHOLDER', 'agent', 'cto', null, true),
    ('Gary', 'cmo@mosbot.local', 'PLACEHOLDER', 'agent', 'cmo', null, true),
    ('Alex', 'cpo@mosbot.local', 'PLACEHOLDER', 'agent', 'cpo', null, true)
ON CONFLICT (email) DO NOTHING;

-- Backward compatibility: Promote legacy owner@mosbot.local or admin@mosbot.local to CEO
DO $$ 
BEGIN
  -- If ceo@mosbot.local doesn't exist but owner@mosbot.local does, update it
  IF NOT EXISTS (SELECT 1 FROM users WHERE email = 'ceo@mosbot.local') THEN
    UPDATE users 
    SET email = 'ceo@mosbot.local', name = 'Marcelo Oliveira'
    WHERE email = 'owner@mosbot.local';
  END IF;
  
  -- If ceo@mosbot.local still doesn't exist but admin@mosbot.local does, update it
  IF NOT EXISTS (SELECT 1 FROM users WHERE email = 'ceo@mosbot.local') THEN
    UPDATE users 
    SET email = 'ceo@mosbot.local', name = 'Marcelo Oliveira', role = 'owner'
    WHERE email = 'admin@mosbot.local';
  END IF;
END $$;

-- Add comment to document the role hierarchy
COMMENT ON COLUMN users.role IS 'User role: owner (CEO only), agent (AI agents), admin (legacy elevated role, still supported), user (regular users)';