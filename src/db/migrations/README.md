# Database Migrations

## Current Schema

The database schema is consolidated into a single initial migration:

- `000_create_migrations_table.sql` - Creates the migrations tracking table
- `001_initial_schema.sql` - Complete database schema with all features (includes agent_id linkage)

## Migration 001 Features

The consolidated `001_initial_schema.sql` includes:

### Tables

- **users** - User accounts with role-based access (owner, agent, admin [legacy, still supported], user)
  - Includes `agent_id` field linking agent users to OpenClaw agent config entries
- **tasks** - Task management with full feature set
- **task_comments** - Per-task discussion threads
- **task_dependencies** - Task blocking relationships
- **activity_logs** - System-wide activity tracking
- **task_logs** - Per-task audit trail

### Task Features

- Task numbering (TASK-1, TASK-2, etc.)
- Parent/child relationships (epics and subtasks)
- Dependencies with circular detection
- Agent usage tracking (cost, tokens, model)
- Preferred model selection
- Comments with event logging
- Full audit trail

### Seed Data

No users are seeded by default. The post-migration script (`001_initial_schema.post.js`)
creates the first owner account from environment variables on a fresh database:

| Variable | Required | Description |
| -------- | -------- | ----------- |
| `BOOTSTRAP_OWNER_EMAIL` | Yes (first run) | Email for the initial owner account |
| `BOOTSTRAP_OWNER_PASSWORD` | Yes (first run) | Password (min 12 chars). Unset after first login. |
| `BOOTSTRAP_OWNER_NAME` | No | Display name (default: `Owner`) |

The bootstrap is **idempotent** — it is skipped if an owner already exists.

See `docs/getting-started/first-run.md` for full setup instructions.

### Agent ID Linkage

The `users` table includes an `agent_id` field for linking agent users to OpenClaw configuration:

- **agent_id** column (unique, nullable TEXT)
  - Links users with `role='agent'` to their OpenClaw agent config entry
  - Format: lowercase slug (e.g., `coo`, `cto`, `ops-assistant`)
  - Constraint: users with `role='agent'` must have a non-null `agent_id`
  - Validation: `agent_id` must match pattern `^[a-z0-9_-]+$`
  - Seeded agents are pre-configured with their corresponding agent IDs

This enables the dashboard to manage OpenClaw agent configurations through the `/settings/users` interface.

## Old Migrations

Previous incremental migrations have been moved to `_old/` for reference:

- `002_task_comments.sql`
- `003_add_comment_event_types.sql`
- `004_add_task_keys_and_relationships.sql`
- `005_add_task_agent_usage_fields.sql`
- `006_add_task_preferred_model_field.sql`

These are no longer needed as all features are consolidated into `001_initial_schema.sql`.

## Resetting the Database

To reset the database with the new consolidated schema:

```bash
# Drop and recreate the database
docker-compose down
docker volume rm mosbot-api_postgres-data  # or your volume name
docker-compose up -d

# Migrations will run automatically on startup
```

Or manually:

```bash
# Connect to postgres
docker exec -it mosbot-postgres psql -U mosbot -d mosbot

# Drop all tables
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO mosbot;
GRANT ALL ON SCHEMA public TO public;

# Exit and restart API to run migrations
\q
docker-compose restart api
```
