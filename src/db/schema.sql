-- MosBot Database Schema

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
  
  CONSTRAINT valid_role CHECK (role IN ('admin', 'user'))
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500) NOT NULL,
  summary TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'PLANNING',
  priority VARCHAR(50),
  type VARCHAR(50) DEFAULT 'task',
  reporter_id UUID REFERENCES users(id) ON DELETE SET NULL,
  assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  due_date TIMESTAMP,
  done_at TIMESTAMP,
  archived_at TIMESTAMP,
  
  CONSTRAINT valid_status CHECK (status IN ('PLANNING', 'TO DO', 'IN PROGRESS', 'DONE', 'ARCHIVE')),
  CONSTRAINT valid_priority CHECK (priority IN ('High', 'Medium', 'Low') OR priority IS NULL),
  CONSTRAINT valid_type CHECK (type IN ('task', 'bug', 'feature', 'improvement', 'research'))
);

-- Activity logs table
CREATE TABLE IF NOT EXISTS activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  title VARCHAR(500) NOT NULL,
  description TEXT NOT NULL,
  category VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(active);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_reporter ON tasks(reporter_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_done_at ON tasks(done_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status_done_at ON tasks(status, done_at);
CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_task_logs_task_occurred ON task_logs(task_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_logs_actor_occurred ON task_logs(actor_id, occurred_at DESC);

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

-- Seed default admin user (idempotent)
-- Default credentials: admin@mosbot.local / admin123
-- IMPORTANT: Change password after first login!
INSERT INTO users (name, email, password_hash, role, avatar_url, active)
VALUES (
  'Admin',
  'admin@mosbot.local',
  '$2b$10$ZnnKYOAALphdWkfm39Bao.fiCpXswsfcOjPqiUNwmfcrEGGiC5hrW',
  'admin',
  null,
  true
)
ON CONFLICT (email) DO NOTHING;
