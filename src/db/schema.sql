-- MosBot Database Schema

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
-- TABLES
-- ============================================================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  avatar_url TEXT,
  role VARCHAR(20) DEFAULT 'user',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT valid_role CHECK (role IN ('owner', 'admin', 'user')),
  CONSTRAINT check_email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
  CONSTRAINT check_name_not_empty CHECK (trim(name) != '')
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500) NOT NULL,
  summary TEXT,
  description TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'PLANNING',
  priority VARCHAR(50),
  type VARCHAR(50) DEFAULT 'task',
  reporter_id UUID REFERENCES users(id) ON DELETE SET NULL,
  assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  tags TEXT[],
  due_date TIMESTAMP,
  done_at TIMESTAMP,
  archived_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  -- Basic validation constraints
  CONSTRAINT valid_status CHECK (status IN ('PLANNING', 'TO DO', 'IN PROGRESS', 'DONE', 'ARCHIVE')),
  CONSTRAINT valid_priority CHECK (priority IN ('High', 'Medium', 'Low') OR priority IS NULL),
  CONSTRAINT valid_type CHECK (type IN ('task', 'bug', 'feature', 'improvement', 'research')),
  
  -- Tags validation constraints
  CONSTRAINT check_tags_array_length CHECK (
    tags IS NULL OR
    array_length(tags, 1) IS NULL OR
    array_length(tags, 1) <= 20
  ),
  CONSTRAINT check_tags_element_length CHECK (validate_tags_length(tags)),
  CONSTRAINT check_tags_lowercase CHECK (validate_tags_lowercase(tags)),
  CONSTRAINT check_tags_not_empty CHECK (validate_tags_not_empty(tags)),
  
  -- Status and timestamp consistency
  CONSTRAINT check_done_at_with_status CHECK (
    (status = 'DONE' AND done_at IS NOT NULL) OR
    (status != 'DONE' AND done_at IS NULL)
  ),
  CONSTRAINT check_archived_at_with_status CHECK (
    (status = 'ARCHIVE' AND archived_at IS NOT NULL) OR
    (status != 'ARCHIVE' AND archived_at IS NULL)
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
  CONSTRAINT check_title_not_empty CHECK (trim(title) != '')
);

-- Activity logs table
CREATE TABLE IF NOT EXISTS activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  title VARCHAR(500) NOT NULL,
  description TEXT NOT NULL,
  -- Legacy free-form category (kept for backward compat; new code uses event_type)
  category VARCHAR(100),
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- v2 unified event taxonomy
  event_type TEXT NOT NULL DEFAULT 'system',
  severity TEXT NOT NULL DEFAULT 'info',
  source TEXT NOT NULL DEFAULT 'system',
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
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
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  source VARCHAR(20) NOT NULL,
  old_values JSONB,
  new_values JSONB,
  meta JSONB,
  
  CONSTRAINT valid_event_type CHECK (event_type IN ('CREATED', 'UPDATED', 'STATUS_CHANGED', 'ARCHIVED_AUTO', 'ARCHIVED_MANUAL', 'RESTORED', 'DELETED')),
  CONSTRAINT valid_source CHECK (source IN ('ui', 'api', 'cron', 'system'))
);

-- ============================================================================
-- INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(active);

-- Enforce exactly one owner (partial unique index)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_owner ON users(role) WHERE role = 'owner';
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_reporter ON tasks(reporter_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_done_at ON tasks(done_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status_done_at ON tasks(status, done_at);
CREATE INDEX IF NOT EXISTS idx_tasks_tags ON tasks USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_task_id ON activity_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_activity_event_type_ts  ON activity_logs(event_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_source_ts       ON activity_logs(source, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_severity_ts     ON activity_logs(severity, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_agent_id_ts     ON activity_logs(agent_id, timestamp DESC) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_job_id          ON activity_logs(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_session_key     ON activity_logs(session_key) WHERE session_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_actor_user_id   ON activity_logs(actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_dedupe_key ON activity_logs(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_logs_task_occurred ON task_logs(task_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_logs_actor_occurred ON task_logs(actor_id, occurred_at DESC);

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

-- ============================================================================
-- SEED DATA
-- ============================================================================

-- No default users are seeded. Use the bootstrap flow (BOOTSTRAP_OWNER_EMAIL /
-- BOOTSTRAP_OWNER_PASSWORD env vars) to create the first owner account.
-- See docs/getting-started/first-run.md for instructions.
