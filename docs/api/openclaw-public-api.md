# Mosbot Public API (for OpenClaw Integration)

This document describes the **public HTTP API contract** OpenClaw can use to integrate with Mosbot as a task backend.

## Table of Contents

- [Versioning](#versioning)
- [Health check](#health-check-no-auth)
- [Config](#config-no-auth)
- [Conventions](#conventions)
  - [Content type](#content-type)
  - [Rate limiting](#rate-limiting)
  - [Authentication (JWT Bearer)](#authentication-jwt-bearer)
  - [Response envelopes](#response-envelopes)
  - [IDs and timestamps](#ids-and-timestamps)
- [Data model (public contract)](#data-model-public-contract)
  - [Task](#task)
  - [Enums](#enums)
  - [Tags normalization rules](#tags-normalization-rules)
  - [User (assignees/reporters)](#user-assigneesreporters)
  - [Task history (audit log)](#task-history-audit-log)
  - [Activity log](#activity-log)
- [Authentication endpoints](#authentication-endpoints)
  - [POST `/auth/login`](#post-authlogin)
  - [GET `/auth/me`](#get-authme)
  - [POST `/auth/verify`](#post-authverify)
- [AI models (for task execution)](#models)
  - [GET `/models`](#get-models)
- [Task endpoints (OpenClaw adapter surface)](#task-endpoints-openclaw-adapter-surface)
  - [GET `/tasks`](#get-tasks)
  - [GET `/tasks/:id`](#get-tasksid)
  - [POST `/tasks`](#post-tasks)
  - [PUT `/tasks/:id` (and PATCH `/tasks/:id`)](#put-tasksid-and-patch-tasksid)
  - [DELETE `/tasks/:id`](#delete-tasksid)
  - [GET `/tasks/:id/history`](#get-tasksidhistory)
  - [GET `/tasks/:id/activity`](#get-tasksidactivity)
  - [GET `/tasks/:id/comments`](#get-tasksidcomments)
  - [POST `/tasks/:id/comments`](#post-tasksidcomments)
  - [PATCH `/tasks/:taskId/comments/:commentId`](#patch-taskstaskidcommentscommentid)
  - [DELETE `/tasks/:taskId/comments/:commentId`](#delete-taskstaskidcommentscommentid)
  - [GET `/tasks/key/:key`](#get-taskskeykey)
  - [GET `/tasks/:id/subtasks`](#get-tasksidsubtasks)
  - [GET `/tasks/:id/dependencies`](#get-tasksiddependencies)
  - [POST `/tasks/:id/dependencies`](#post-tasksiddependencies)
  - [DELETE `/tasks/:id/dependencies/:dependsOnId`](#delete-tasksiddependenciesdependsonid)
- [Users (for assignee resolution)](#users-for-assignee-resolution)
  - [GET `/users`](#get-users)
  - [GET `/users/:id`](#get-usersid)
- [Admin user management (agent/admin/owner only)](#admin-user-management-agentadminowner-only)
  - [GET `/admin/users`](#get-adminusers)
  - [GET `/admin/users/:id`](#get-adminusersid)
  - [POST `/admin/users`](#post-adminusers)
  - [PUT `/admin/users/:id`](#put-adminusersid)
  - [DELETE `/admin/users/:id`](#delete-adminusersid)
- [Activity logs (optional)](#activity-logs-optional)
  - [GET `/activity`](#get-activity)
- [Standups](#standups)
  - [GET `/standups`](#get-standups)
  - [GET `/standups/latest`](#get-standupslatest)
  - [GET `/standups/:id`](#get-standupsid)
  - [POST `/standups`](#post-standups-admin)
  - [PATCH `/standups/:id`](#patch-standupsid-admin)
  - [DELETE `/standups/:id`](#delete-standupsid-admin)
  - [POST `/standups/:id/run`](#post-standupsidrun-admin)
  - [GET `/standups/:id/entries`](#get-standupsidentries)
  - [POST `/standups/:id/entries`](#post-standupsidentries-admin)
  - [PATCH `/standups/:id/entries/:entryId`](#patch-standupsidentriesentryid-admin)
  - [DELETE `/standups/:id/entries/:entryId`](#delete-standupsidentriesentryid-admin)
  - [GET `/standups/:id/messages`](#get-standupsidmessages)
  - [POST `/standups/:id/messages`](#post-standupsidmessages-admin)
  - [DELETE `/standups/:id/messages/:messageId`](#delete-standupsidmessagesmessageid-admin)
- [OpenClaw workspace integration](#openclaw-workspace-integration)
  - [GET `/openclaw/workspace/files`](#get-openclawworkspacefiles)
  - [GET `/openclaw/workspace/files/content`](#get-openclawworkspacefilescontent)
  - [POST `/openclaw/workspace/files`](#post-openclawworkspacefiles)
  - [PUT `/openclaw/workspace/files`](#put-openclawworkspacefiles)
  - [DELETE `/openclaw/workspace/files`](#delete-openclawworkspacefiles)
  - [GET `/openclaw/workspace/status`](#get-openclawworkspacestatus)
  - [GET `/openclaw/subagents`](#get-openclawsubagents)
- [Recommended OpenClaw integration flow (example)](#recommended-openclaw-integration-flow-example)

## Versioning

- **API version**: `v1`
- **Base URL**: `<MOSBOT_API_ORIGIN>/api/v1`
  - Example (local): `http://localhost:3000/api/v1`

## Health check (no auth)

- **GET** `<MOSBOT_API_ORIGIN>/health`

Response `200`:

```json
{ "status": "ok", "timestamp": "2026-02-05T12:34:56.789Z" }
```

### Config (no auth)

- **GET** `<MOSBOT_API_ORIGIN>/api/v1/config`

Returns non-sensitive instance settings (e.g., timezone for standup scheduling).

Response `200`:

```json
{
  "data": {
    "timezone": "Asia/Singapore"
  }
}
```

## Conventions

### Content type

- Send JSON bodies with header `Content-Type: application/json`.

### Rate limiting

All routes under `/api/*` are rate limited (15-minute windows):

- **Production default**: 100 requests / 15 minutes
- **Development default**: 1000 requests / 15 minutes

When rate-limited, the API responds with `429`:

```json
{ "error": { "message": "Too many requests, please try again later.", "status": 429 } }
```

### Authentication (JWT Bearer)

Most integrations should authenticate as a dedicated Mosbot user and send:

```bash
Authorization: Bearer <JWT>
```

You can obtain a JWT via `POST /auth/login`.

Notes:

- Some endpoints currently allow requests without a token (they behave as “anonymous”), but **OpenClaw should still authenticate** so Mosbot can attribute actions (e.g. `reporter_id`) and support future access controls consistently.

### Response envelopes

- **Success**: `{ "data": ... }`
- **List success**: `{ "data": [...], "pagination": { "limit": number, "offset": number, "total": number } }`
  - `pagination.total` is the **count returned in this response** (not a full “count of all matching records”).
- **Error**: `{ "error": { "message": string, "status": number } }`

### IDs and timestamps

- All IDs are **UUIDs** (string).
- Timestamps are returned as ISO-like strings from PostgreSQL (treat as ISO 8601).

## Data model (public contract)

### Task

Core fields (always present unless noted):

- `id` (uuid)
- `task_number` (integer, auto-incremented, unique) - Used to generate human-friendly task keys like `TASK-1234`
- `title` (string, max 500)
- `summary` (string | null)
- `status` (enum, see below)
- `priority` (`High` | `Medium` | `Low` | null)
- `type` (`task` | `bug` | `feature` | `improvement` | `research` | `epic`)
- `reporter_id` (uuid | null)
- `assignee_id` (uuid | null)
- `tags` (string[] | null)
- `due_date` (timestamp | null)
- `done_at` (timestamp | null)
- `archived_at` (timestamp | null)
- `parent_task_id` (uuid | null) - For epic/subtask relationships
- `parent_sort_order` (integer | null) - Sort order for subtasks under the same parent
- `agent_cost_usd` (decimal | null) - AI agent cost in USD (usage metric)
- `agent_tokens_input` (integer | null) - Input tokens used (usage metric)
- `agent_tokens_input_cache` (integer | null) - Cached input tokens used (usage metric)
- `agent_tokens_output` (integer | null) - Output tokens generated (usage metric)
- `agent_tokens_output_cache` (integer | null) - Cached output tokens used (usage metric)
- `agent_model` (string | null) - AI model name actually used (e.g., "claude-3-5-sonnet-20241022") (usage metric)
- `agent_model_provider` (string | null) - AI model provider actually used (e.g., "anthropic", "openai") (usage metric)
- `preferred_model` (string | null) - User's preferred AI model for execution (use `id` from `GET /models`; null = use system default)
- `created_at` (timestamp)
- `updated_at` (timestamp)

Denormalized/joined fields (may appear on some endpoints):

- `reporter_name`, `reporter_email`, `reporter_avatar`
- `assignee_name`, `assignee_email`, `assignee_avatar`
- `parent_task_number`, `parent_task_title` - Information about the parent task (if applicable)

### Enums

- **Task status**: `PLANNING` | `TO DO` | `IN PROGRESS` | `DONE` | `ARCHIVE`
- **Task priority**: `High` | `Medium` | `Low`
- **Task type**: `task` | `bug` | `feature` | `improvement` | `research` | `epic`

### Tags normalization rules

When creating/updating a task:

- `tags` must be an array of strings (or `null`).
- Max **20** tags per task.
- Each tag is trimmed, converted to lowercase, deduplicated case-insensitively.
- Empty strings are ignored.
- Max **50** characters per tag.
- If the normalized list is empty, Mosbot stores `tags` as `null`.

### User (assignees/reporters)

- `id` (uuid)
- `name` (string)
- `email` (string)
- `avatar_url` (string | null)
- `active` (boolean) — present on list endpoints
- `created_at`, `updated_at` (timestamp)

### Task history (audit log)

Returned by `GET /tasks/:id/history`:

- `id` (uuid)
- `task_id` (uuid)
- `event_type` (enum): `CREATED` | `UPDATED` | `STATUS_CHANGED` | `ARCHIVED_AUTO` | `ARCHIVED_MANUAL` | `RESTORED` | `DELETED` | `COMMENT_CREATED` | `COMMENT_UPDATED` | `COMMENT_DELETED`
- `occurred_at` (timestamp)
- `actor_id` (uuid | null)
- `source` (enum): `ui` | `api` | `cron` | `system`
- `old_values` (object | null)
- `new_values` (object | null)
- `meta` (object | null)
- `actor_name`, `actor_email`, `actor_avatar` (nullable joined fields)

### Task comment

Returned by comment endpoints:

- `id` (uuid)
- `task_id` (uuid)
- `author_id` (uuid | null)
- `body` (string, max 5000 characters)
- `created_at` (timestamp)
- `updated_at` (timestamp)
- `author_name`, `author_email`, `author_avatar` (nullable joined fields)

### Activity log

Returned by `GET /activity` and `GET /tasks/:id/activity`:

- `id` (uuid)
- `timestamp` (timestamp)
- `title` (string, max 500)
- `description` (string)
- `category` (string | null)
- `task_id` (uuid | null)
- `created_at` (timestamp)

### Standup

Returned by standup endpoints:

- `id` (uuid)
- `standup_date` (date, unique per day)
- `title` (string)
- `timezone` (string, e.g., `Asia/Singapore`)
- `status` (enum): `running` | `completed` | `error`
- `started_at` (timestamp | null)
- `completed_at` (timestamp | null)
- `created_at` (timestamp)
- `updated_at` (timestamp)

List responses also include:

- `entry_count` (integer) — number of agent entries
- `participants` (array) — `{ agent_id, user_id, user_name, avatar_url }[]`

### Standup entry

Returned by `GET /standups/:id`:

- `id` (uuid)
- `standup_id` (uuid)
- `agent_id` (string, e.g., `coo`, `cto`)
- `user_id` (uuid | null)
- `user_name` (string | null)
- `avatar_url` (string | null)
- `turn_order` (integer)
- `yesterday` (string | null)
- `today` (string | null)
- `blockers` (string | null)
- `tasks` (array | null) — optional structured task data `[{ "id": "TASK-123", "title": "...", "status": "..." }]`
- `raw` (string) — full raw response from the agent
- `created_at` (timestamp)

### Standup message

Returned by `GET /standups/:id` (agent transcript messages only):

- `id` (uuid)
- `standup_id` (uuid)
- `kind` (string): `agent` (system messages are omitted from API)
- `agent_id` (string | null)
- `content` (string)
- `created_at` (timestamp)

## Authentication endpoints

### POST `/auth/login`

Authenticate and obtain a JWT.

Request:

```json
{
  "email": "owner@mosbot.local",
  "password": "your-password"
}
```

Response `200`:

```json
{
  "data": {
    "user": {
      "id": "uuid",
      "name": "Owner",
      "email": "owner@mosbot.local",
      "avatar_url": null,
      "role": "owner"
    },
    "token": "jwt",
    "expires_in": "7d"
  }
}
```

Common errors:

- `400` missing email/password
- `401` invalid credentials
- `403` account deactivated

### GET `/auth/me`

Get the current user from the JWT.

Response `200`:

```json
{ "data": { "id": "uuid", "name": "...", "email": "...", "avatar_url": null, "role": "user", "active": true, "created_at": "..." } }
```

### POST `/auth/verify`

Verify a JWT is valid.

Response `200`:

```json
{ "data": { "valid": true, "user": { "id": "uuid", "name": "...", "email": "...", "avatar_url": null, "role": "user", "active": true } } }
```

## Models

Use the models endpoint to discover which AI models can be used for task execution. When creating or updating a task, set `preferred_model` to a model's `id` from this list; use `null` to fall back to the system default.

### GET `/models`

List all available AI models that can be selected for task execution.

Response `200`:

```json
{
  "data": {
    "models": [
      {
        "id": "openrouter/anthropic/claude-sonnet-4.5",
        "name": "Anthropic - Claude Sonnet 4.5",
        "params": { "maxTokens": 8000 },
        "provider": "anthropic"
      },
      {
        "id": "openrouter/moonshotai/kimi-k2.5",
        "name": "Moonshot AI - Kimi K2.5",
        "params": { "contextWindow": 256000, "maxTokens": 8000, "reasoning": false },
        "provider": "moonshotai"
      }
    ],
    "defaultModel": "openrouter/moonshotai/kimi-k2.5"
  }
}
```

Each model object:

- `id` — model identifier; use when setting `preferred_model` on a task
- `name` — display name (from config alias)
- `params` — optional model parameters (`contextWindow`, `maxTokens`, `reasoning`); shape varies by model
- `provider` — extracted from model ID path (e.g. `anthropic` from `openrouter/anthropic/...`)

Notes:

- The `id` field is used when setting `preferred_model` on a task
- The `provider` field is automatically determined from the model ID path
- `defaultModel` indicates which model is used when `preferred_model` is `null`

## Task endpoints (OpenClaw adapter surface)

### GET `/tasks`

List tasks (most recent first).

Query parameters:

- `status` (optional): one of the status enum values
- `include_archived` (optional): `true` to include archived tasks (default is exclude archived)
- `assignee_id` (optional uuid)
- `reporter_id` (optional uuid)
- `priority` (optional): `High` | `Medium` | `Low`
- `limit` (optional, default `100`, max `1000`)
- `offset` (optional, default `0`)

Response `200`:

```json
{
  "data": [/* Task[] */],
  "pagination": { "limit": 100, "offset": 0, "total": 42 }
}
```

Example:

```bash
curl "<MOSBOT_API_ORIGIN>/api/v1/tasks?status=IN%20PROGRESS&limit=50" \
  -H "Authorization: Bearer <JWT>"
```

### GET `/tasks/:id`

Fetch a single task by UUID.

Response `200`:

```json
{ "data": { /* Task */ } }
```

Errors:

- `400` invalid UUID
- `404` task not found

### GET `/tasks/key/:key`

Fetch a single task by its human-friendly key (e.g., `TASK-1234`).

Response `200`:

```json
{
  "data": {
    "id": "uuid",
    "task_number": 1234,
    "title": "Example task",
    "status": "IN PROGRESS",
    ...
  }
}
```

Errors:

- `400` invalid task key format (expected `TASK-{number}`)
- `404` task not found

### POST `/tasks`

Create a task.

Request body:

```json
{
  "title": "Write OpenClaw integration docs",
  "summary": "Public API contract + examples",
  "status": "PLANNING",
  "priority": "High",
  "type": "task",
  "reporter_id": "uuid (optional)",
  "assignee_id": "uuid (optional)",
  "due_date": "2026-02-05T18:00:00.000Z (optional)",
  "tags": ["OpenClaw", "Docs", "API"],
  "parent_task_id": "uuid (optional)",
  "agent_cost_usd": 0.0523 (optional),
  "agent_tokens_input": 1500 (optional),
  "agent_tokens_input_cache": 500 (optional),
  "agent_tokens_output": 800 (optional),
  "agent_tokens_output_cache": 200 (optional),
  "agent_model": "claude-3-5-sonnet-20241022 (optional)",
  "agent_model_provider": "anthropic (optional)",
  "preferred_model": "openrouter/anthropic/claude-sonnet-4.5 (optional, null = use system default)"
}
```

Behavior notes:

- If `status` is omitted it defaults to `PLANNING`.
- If `type` is omitted it defaults to `task`.
- If `reporter_id` is omitted and a JWT is provided, Mosbot sets `reporter_id` to the authenticated user.
- `tags` are normalized (see rules above).
- `parent_task_id` creates a parent/child relationship (useful for epics with subtasks).
- `task_number` is automatically assigned from a sequence and cannot be set manually.

Response `201`:

```json
{ "data": { /* Task */ } }
```

Errors:

- `400` validation errors (missing title, invalid enum values, parent task not found, etc.)

### PUT `/tasks/:id` (and PATCH `/tasks/:id`)

Update a task. `PATCH` is supported and behaves the same as `PUT`.

You may send any subset of these fields:

- `title`, `summary`, `status`, `priority`, `type`, `reporter_id`, `assignee_id`, `due_date`, `tags`, `parent_task_id`
- `agent_cost_usd`, `agent_tokens_input`, `agent_tokens_input_cache`, `agent_tokens_output`, `agent_tokens_output_cache`, `agent_model`, `agent_model_provider`
- `preferred_model`

Agent fields notes:

- **Usage metrics** (`agent_cost_usd`, `agent_tokens_*`, `agent_model`, `agent_model_provider`): These fields track AI model usage and cost per task after execution. All are optional and can be set to `null`.
  - `agent_cost_usd` should be a decimal number (e.g., `0.0523`)
  - Token fields should be non-negative integers
  - Model and provider should be strings identifying the AI service actually used
- **User preference** (`preferred_model`): This field stores the user's preferred AI model ID for task execution. Use the `id` from `GET /api/v1/models` (e.g., `"openrouter/anthropic/claude-sonnet-4.5"`). Use `null` to indicate system default. Max 200 characters.

Status transition side-effects:

- Transition to `DONE` sets `done_at` to now.
- Transition away from `DONE` clears `done_at` (except when moving to `ARCHIVE`).
- Transition to `ARCHIVE` sets `archived_at` to now.
- Transition away from `ARCHIVE` clears `archived_at`.

Response `200`:

```json
{ "data": { /* updated Task */ } }
```

Errors:

- `400` invalid UUID, invalid enum, invalid tags, parent task not found, or no fields to update
- `404` task not found

### DELETE `/tasks/:id`

Delete a task.

Response `204` with no body.

### GET `/tasks/:id/subtasks`

Get all subtasks (children) of a task, ordered by `parent_sort_order` and `created_at`.

Response `200`:

```json
{
  "data": [
    {
      "id": "uuid",
      "task_number": 1235,
      "title": "Subtask 1",
      "parent_task_id": "uuid",
      "parent_sort_order": 1,
      ...
    }
  ]
}
```

Errors:

- `400` invalid UUID
- `404` task not found

### GET `/tasks/:id/dependencies`

Get task dependencies (both tasks this task depends on, and tasks that depend on this task).

Response `200`:

```json
{
  "data": {
    "depends_on": [
      {
        "id": "uuid",
        "task_number": 1230,
        "title": "Blocking task",
        ...
      }
    ],
    "dependents": [
      {
        "id": "uuid",
        "task_number": 1240,
        "title": "Dependent task",
        ...
      }
    ]
  }
}
```

Errors:

- `400` invalid UUID
- `404` task not found

### POST `/tasks/:id/dependencies`

Add a dependency relationship (this task depends on another task).

Request body:

```json
{
  "depends_on_task_id": "uuid"
}
```

Validation:

- Prevents self-dependencies (task cannot depend on itself)
- Prevents circular dependencies (A→B→C→A cycles)
- Prevents duplicate dependencies

Response `201`:

```json
{
  "data": {
    "task_id": "uuid",
    "depends_on_task_id": "uuid"
  }
}
```

Errors:

- `400` invalid UUID, missing `depends_on_task_id`, self-dependency, or circular dependency
- `404` one or both tasks not found
- `409` dependency already exists

### DELETE `/tasks/:id/dependencies/:dependsOnId`

Remove a dependency relationship.

Response `204` with no body.

Errors:

- `400` invalid UUID
- `404` dependency not found

### GET `/tasks/:id/history`

Get the audit/history events for a task.

Query parameters:

- `limit` (optional, default `100`)
- `offset` (optional, default `0`)

Response `200`:

```json
{
  "data": [/* TaskLog[] */],
  "pagination": { "limit": 100, "offset": 0, "total": 10 }
}
```

### GET `/tasks/:id/activity`

Get activity log rows for a task.

Query parameters:

- `limit` (optional, default `100`)
- `offset` (optional, default `0`)

Response `200`:

```json
{
  "data": [/* ActivityLog[] */],
  "pagination": { "limit": 100, "offset": 0, "total": 5 }
}
```

### GET `/tasks/:id/comments`

Get comments for a task (oldest first).

Query parameters:

- `limit` (optional, default `100`)
- `offset` (optional, default `0`)

Response `200`:

```json
{
  "data": [
    {
      "id": "uuid",
      "task_id": "uuid",
      "author_id": "uuid",
      "author_name": "John Doe",
      "author_email": "john@example.com",
      "author_avatar": null,
      "body": "This is a comment",
      "created_at": "2026-02-06T12:34:56.789Z",
      "updated_at": "2026-02-06T12:34:56.789Z"
    }
  ],
  "pagination": { "limit": 100, "offset": 0, "total": 1 }
}
```

Errors:

- `400` invalid UUID
- `404` task not found

### POST `/tasks/:id/comments`

Create a comment on a task.

**Authentication required** - comment will be attributed to the authenticated user.

Request body:

```json
{
  "body": "This is my comment (1-5000 characters)"
}
```

Response `201`:

```json
{
  "data": {
    "id": "uuid",
    "task_id": "uuid",
    "author_id": "uuid",
    "author_name": "John Doe",
    "author_email": "john@example.com",
    "author_avatar": null,
    "body": "This is my comment",
    "created_at": "2026-02-06T12:34:56.789Z",
    "updated_at": "2026-02-06T12:34:56.789Z"
  }
}
```

Audit log: Creates a `COMMENT_CREATED` event in task history.

Errors:

- `400` invalid UUID, missing body, or body too long (>5000 chars)
- `401` authentication required
- `404` task not found

### PATCH `/tasks/:taskId/comments/:commentId`

Update a comment.

**Authorization**: Only the comment author OR admin/owner can edit.

Request body:

```json
{
  "body": "Updated comment text (1-5000 characters)"
}
```

Response `200`:

```json
{
  "data": {
    "id": "uuid",
    "task_id": "uuid",
    "author_id": "uuid",
    "author_name": "John Doe",
    "author_email": "john@example.com",
    "author_avatar": null,
    "body": "Updated comment text",
    "created_at": "2026-02-06T12:34:56.789Z",
    "updated_at": "2026-02-06T12:45:00.000Z"
  }
}
```

Audit log: Creates a `COMMENT_UPDATED` event in task history with old and new body values.

Errors:

- `400` invalid UUID, missing body, or body too long
- `401` authentication required
- `403` only comment author or admin/owner can edit
- `404` comment or task not found

### DELETE `/tasks/:taskId/comments/:commentId`

Delete a comment.

**Authorization**: Only the comment author OR admin/owner can delete.

Response `204` with no body.

Audit log: Creates a `COMMENT_DELETED` event in task history with the deleted body.

Errors:

- `400` invalid UUID
- `401` authentication required
- `403` only comment author or admin/owner can delete
- `404` comment or task not found

## Users (for assignee resolution)

### GET `/users`

List users (use this for assignee selection/resolution).

Query parameters:

- `search` (optional): matches `name` or `email` (case-insensitive)
- `active_only` (optional): `true` to include only active users
- `limit` (optional, default `100`, max `1000`)
- `offset` (optional, default `0`)

Response `200`:

```json
{
  "data": [/* User[] */],
  "pagination": { "limit": 100, "offset": 0, "total": 3 }
}
```

### GET `/users/:id`

Fetch a single user by id.

Response `200`:

```json
{ "data": { "id": "uuid", "name": "...", "email": "...", "avatar_url": null, "created_at": "...", "updated_at": "..." } }
```

## Admin user management (agent/admin/owner only)

These endpoints require agent, admin or owner role.

### GET `/admin/users`

List all users (all authenticated users can view).

Query parameters:

- `limit` (optional, default `100`, max `1000`)
- `offset` (optional, default `0`)

Response `200`:

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "...",
      "email": "...",
      "avatar_url": null,
      "role": "user",
      "active": true,
      "created_at": "...",
      "updated_at": "..."
    }
  ],
  "pagination": { "limit": 100, "offset": 0, "total": 5 }
}
```

### GET `/admin/users/:id`

Get a single user by ID (all authenticated users can view).

Response `200`:

```json
{
  "data": {
    "id": "uuid",
    "name": "...",
    "email": "...",
    "avatar_url": null,
    "role": "user",
    "active": true,
    "created_at": "...",
    "updated_at": "..."
  }
}
```

### POST `/admin/users`

Create a new user (admin/owner only).

Request body:

```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "securepassword",
  "role": "user",
  "avatar_url": "https://example.com/avatar.jpg"
}
```

Notes:

- `role` defaults to `user` if omitted. Valid values: `agent`, `admin`, `user` (owner role cannot be assigned via this endpoint)
- `password` must be at least 8 characters
- User is created as active by default

Response `201`:

```json
{
  "data": {
    "id": "uuid",
    "name": "John Doe",
    "email": "john@example.com",
    "avatar_url": "https://example.com/avatar.jpg",
    "role": "user",
    "active": true,
    "created_at": "..."
  }
}
```

Errors:

- `400` validation errors (missing name, invalid email, password too short, invalid role)
- `409` email already exists

### PUT `/admin/users/:id`

Update a user (admin/owner only).

Request body (all fields optional):

```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "password": "newpassword",
  "role": "admin",
  "avatar_url": "https://example.com/new-avatar.jpg",
  "active": false
}
```

Protection rules:

- Admin cannot edit owner accounts
- Owner cannot change their own role
- Owner cannot deactivate themselves
- Cannot deactivate your own account
- Cannot delete your own account

Response `200`:

```json
{
  "data": {
    "id": "uuid",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "avatar_url": "https://example.com/new-avatar.jpg",
    "role": "admin",
    "active": false,
    "created_at": "...",
    "updated_at": "..."
  }
}
```

Errors:

- `400` validation errors or no fields to update
- `403` permission denied (e.g., admin trying to edit owner)
- `404` user not found
- `409` email already exists

### DELETE `/admin/users/:id`

Delete a user (admin/owner only).

Response `204` with no body.

Protection rules:

- Cannot delete your own account
- Owner account cannot be deleted by anyone
- Admin cannot delete owner

Errors:

- `400` attempting to delete own account
- `403` permission denied (e.g., trying to delete owner)
- `404` user not found

## Activity logs (optional)

### GET `/activity`

List activity logs across the system.

Query parameters:

- `category` (optional string)
- `task_id` (optional uuid)
- `start_date` (optional timestamp string)
- `end_date` (optional timestamp string)
- `limit` / `offset` (optional; default `100` / `0`)

Response `200`:

```json
{
  "data": [/* ActivityLog[] */],
  "pagination": { "limit": 100, "offset": 0, "total": 25 }
}
```

## Standups

Daily executive standups collect progress reports from agent users (COO, CTO, CPO, CMO) via OpenClaw Gateway `sessions_send`. Standups are triggered by the **OpenClaw Scheduler** (a cron job in `/cron/jobs.json`) and stored in the database. These endpoints allow clients to list, retrieve, create, update, delete, and run standups.

For a full architectural explanation see [docs/features/standups.md](../features/standups.md).

**Authentication required** — all standup endpoints require a valid JWT.

**Authorization** — read endpoints are available to any authenticated user. Write endpoints (`POST`, `PATCH`, `DELETE`) and the run endpoint require an elevated role (`owner`, `agent`, or `admin`).

### GET `/standups`

List standups (newest first) with pagination.

Query parameters:

- `limit` (optional, default `50`, max `100`)
- `offset` (optional, default `0`)

Response `200`:

```json
{
  "data": [
    {
      "id": "uuid",
      "standup_date": "2026-02-18",
      "title": "Executive Standup — Tuesday, February 18, 2026",
      "timezone": "Asia/Singapore",
      "status": "completed",
      "started_at": "2026-02-18T00:08:00.000Z",
      "completed_at": "2026-02-18T00:12:30.000Z",
      "created_at": "2026-02-18T00:08:00.000Z",
      "updated_at": "2026-02-18T00:12:30.000Z",
      "entry_count": 4,
      "participants": [
        { "agent_id": "coo", "user_id": "uuid", "user_name": "COO Agent", "avatar_url": null },
        { "agent_id": "cto", "user_id": "uuid", "user_name": "CTO Agent", "avatar_url": null }
      ]
    }
  ],
  "pagination": { "limit": 50, "offset": 0, "total": 10 }
}
```

Errors:

- `401` authentication required

### GET `/standups/latest`

Get the most recent standup (same shape as list items, no `entries` or `messages`).

Response `200`:

```json
{
  "data": {
    "id": "uuid",
    "standup_date": "2026-02-18",
    "title": "Executive Standup — Tuesday, February 18, 2026",
    "timezone": "Asia/Singapore",
    "status": "completed",
    "started_at": "2026-02-18T00:08:00.000Z",
    "completed_at": "2026-02-18T00:12:30.000Z",
    "created_at": "2026-02-18T00:08:00.000Z",
    "updated_at": "2026-02-18T00:12:30.000Z",
    "entry_count": 4,
    "participants": [/* ... */]
  }
}
```

Errors:

- `401` authentication required
- `404` no standups found

### GET `/standups/:id`

Get a specific standup with full entries and transcript messages.

Response `200`:

```json
{
  "data": {
    "id": "uuid",
    "standup_date": "2026-02-18",
    "title": "Executive Standup — Tuesday, February 18, 2026",
    "timezone": "Asia/Singapore",
    "status": "completed",
    "started_at": "2026-02-18T00:08:00.000Z",
    "completed_at": "2026-02-18T00:12:30.000Z",
    "created_at": "2026-02-18T00:08:00.000Z",
    "updated_at": "2026-02-18T00:12:30.000Z",
    "entries": [
      {
        "id": "uuid",
        "standup_id": "uuid",
        "agent_id": "coo",
        "user_id": "uuid",
        "user_name": "COO Agent",
        "avatar_url": null,
        "turn_order": 1,
        "yesterday": "Reviewed Q1 metrics.",
        "today": "Focus on operational improvements.",
        "blockers": "None.",
        "tasks": [{"id": "TASK-123", "title": "Update metrics", "status": "IN PROGRESS"}],
        "raw": "Yesterday: ...\nToday: ...\nBlockers: ...\nTasks: ...",
        "created_at": "2026-02-18T00:08:30.000Z"
      }
    ],
    "messages": [
      {
        "id": "uuid",
        "standup_id": "uuid",
        "kind": "agent",
        "agent_id": "coo",
        "content": "Yesterday: ...\nToday: ...",
        "created_at": "2026-02-18T00:08:30.000Z"
      }
    ]
  }
}
```

**Notes**:

- `entries` are ordered by `turn_order` (COO → CTO → CPO → CMO)
- `messages` contains only `kind: "agent"` transcript items (system messages omitted)

Errors:

- `400` invalid UUID
- `401` authentication required
- `404` standup not found

### POST `/standups` (admin)

Create a standup record. Normally standups are created by the OpenClaw Scheduler job; use this to create one manually or to create a record before running it.

Request body:

```json
{
  "standup_date": "2026-02-18",
  "title": "Executive Standup — Tuesday, February 18, 2026",
  "timezone": "Asia/Singapore",
  "status": "running",
  "started_at": "2026-02-18T00:08:00.000Z",
  "completed_at": null
}
```

Required fields: `standup_date`, `title`, `timezone`.

- `status` defaults to `running` if omitted. Valid values: `running` | `completed` | `error`.
- `started_at` and `completed_at` are optional timestamps.

Response `201`:

```json
{ "data": { /* Standup */ } }
```

Errors:

- `400` validation errors (missing required field, invalid status)
- `401` authentication required
- `403` elevated role required
- `409` a standup for this date already exists

### PATCH `/standups/:id` (admin)

Update fields on a standup record. Send any subset of fields.

Updatable fields: `standup_date`, `title`, `timezone`, `status`, `started_at`, `completed_at`.

Request body:

```json
{
  "status": "error",
  "completed_at": "2026-02-18T00:15:00.000Z"
}
```

Response `200`:

```json
{ "data": { /* updated Standup */ } }
```

Errors:

- `400` validation errors or no fields to update
- `401` authentication required
- `403` elevated role required
- `404` standup not found
- `409` a standup for the new date already exists

### DELETE `/standups/:id` (admin)

Delete a standup. Cascades to all `standup_entries` and `standup_messages` for that standup.

Response `204` with no body.

Errors:

- `400` invalid UUID
- `401` authentication required
- `403` elevated role required
- `404` standup not found

### POST `/standups/:id/run` (admin)

Run standup collection for an existing standup record. Contacts each active agent user (COO → CTO → CPO → CMO) via OpenClaw Gateway `sessions_send`, parses their responses, and persists entries and messages.

**Idempotent**: re-running clears all existing entries and messages for the standup before writing fresh rows within a single transaction.

Use this to:

- Retry a failed standup (`status: "error"`).
- Run a standup off-schedule.
- Test standup collection in development.

Response `200` — returns the updated standup record:

```json
{ "data": { /* updated Standup */ } }
```

Errors:

- `400` invalid UUID
- `401` authentication required
- `403` elevated role required
- `404` standup not found
- `500` collection failed (e.g. no active agent users configured)

### GET `/standups/:id/entries`

List all entries for a standup, ordered by `turn_order`.

Response `200`:

```json
{ "data": [/* StandupEntry[] */] }
```

Errors:

- `400` invalid UUID
- `401` authentication required
- `404` standup not found

### POST `/standups/:id/entries` (admin)

Manually add a standup entry (e.g. for correction or a non-OpenClaw agent).

Request body:

```json
{
  "agent_id": "coo",
  "user_id": "uuid (optional)",
  "turn_order": 1,
  "yesterday": "Reviewed Q1 metrics.",
  "today": "Focus on operational improvements.",
  "blockers": "None.",
  "tasks": [{"id": "TASK-123", "title": "Update metrics", "status": "IN PROGRESS"}],
  "raw": "Yesterday: ...\nToday: ...\nBlockers: ..."
}
```

Required fields: `agent_id`, `raw`.

Response `201`:

```json
{ "data": { /* StandupEntry */ } }
```

Errors:

- `400` validation errors (missing agent_id, missing raw, invalid turn_order)
- `401` authentication required
- `403` elevated role required
- `404` standup not found

### PATCH `/standups/:id/entries/:entryId` (admin)

Update a standup entry. Send any subset of fields.

Updatable fields: `agent_id`, `user_id`, `turn_order`, `yesterday`, `today`, `blockers`, `tasks`, `raw`.

Response `200`:

```json
{ "data": { /* updated StandupEntry */ } }
```

Errors:

- `400` validation errors or no fields to update
- `401` authentication required
- `403` elevated role required
- `404` entry not found (or does not belong to this standup)

### DELETE `/standups/:id/entries/:entryId` (admin)

Delete a standup entry.

Response `204` with no body.

Errors:

- `400` invalid UUID
- `401` authentication required
- `403` elevated role required
- `404` entry not found

### GET `/standups/:id/messages`

List all transcript messages for a standup (all kinds, including `system`), ordered by `created_at`.

Response `200`:

```json
{
  "data": [
    {
      "id": "uuid",
      "standup_id": "uuid",
      "kind": "agent",
      "agent_id": "coo",
      "content": "Yesterday: ...\nToday: ...",
      "created_at": "2026-02-18T00:08:30.000Z"
    }
  ]
}
```

Errors:

- `400` invalid UUID
- `401` authentication required
- `404` standup not found

### POST `/standups/:id/messages` (admin)

Manually add a transcript message.

Request body:

```json
{
  "kind": "agent",
  "agent_id": "coo",
  "content": "Yesterday: Reviewed Q1 metrics.\nToday: Operational improvements."
}
```

- `kind` is required: `agent` | `system`.
- `agent_id` is optional (set for agent messages, omit for system messages).
- `content` is required.

Response `201`:

```json
{ "data": { /* StandupMessage */ } }
```

Errors:

- `400` validation errors (invalid kind, missing content)
- `401` authentication required
- `403` elevated role required
- `404` standup not found

### DELETE `/standups/:id/messages/:messageId` (admin)

Delete a transcript message.

Response `204` with no body.

Errors:

- `400` invalid UUID
- `401` authentication required
- `403` elevated role required
- `404` message not found

## OpenClaw workspace integration

These endpoints integrate with the OpenClaw workspace service for file management.

**Note**: OpenClaw workspace service must be configured via `OPENCLAW_WORKSPACE_URL` environment variable. In local development, this must be explicitly set. In production, it defaults to the Kubernetes service URL.

### GET `/openclaw/workspace/files`

List workspace files (all authenticated users can view metadata).

Query parameters:

- `path` (optional, default `/`): workspace path to list
- `recursive` (optional, default `false`): whether to list recursively

Response `200`:

```json
{
  "data": {
    "files": [
      {
        "name": "example.txt",
        "path": "/example.txt",
        "type": "file",
        "size": 1024,
        "modified": "2026-02-05T12:34:56.789Z",
        "created": "2026-02-01T10:00:00.000Z"
      },
      {
        "name": "docs",
        "path": "/docs",
        "type": "directory",
        "size": 4096,
        "modified": "2026-02-05T12:34:56.789Z",
        "created": "2026-02-01T10:00:00.000Z",
        "isSymlink": true,
        "symlinkTarget": "/shared/documentation"
      }
    ]
  }
}
```

**Symlink fields** (present only when `isSymlink: true`):

- `isSymlink` (boolean): `true` if the file/directory is a symbolic link
- `symlinkTarget` (string): The path the symlink points to (may be relative or absolute)

Errors:

- `400` invalid path (e.g., path traversal attempts)
- `401` authentication required
- `503` OpenClaw service not configured or unavailable

### GET `/openclaw/workspace/files/content`

Read file content (admin/owner only).

Query parameters:

- `path` (required): workspace file path

Response `200`:

```json
{
  "data": {
    "path": "/example.txt",
    "content": "file content here",
    "encoding": "utf8"
  }
}
```

Errors:

- `400` missing or invalid path
- `401` authentication required
- `403` agent/admin/owner role required
- `404` file not found
- `503` OpenClaw service not configured or unavailable

### POST `/openclaw/workspace/files`

Create a new file (admin/owner only). **Fails if file already exists** - use `PUT` to update existing files.

Request body:

```json
{
  "path": "/new-file.txt",
  "content": "file content",
  "encoding": "utf8"
}
```

Notes:

- `encoding` defaults to `utf8` if omitted
- Path is normalized and validated (no path traversal allowed)
- Checks for file existence before creation to prevent accidental overwrites

Response `201`:

```json
{
  "data": {
    "path": "/new-file.txt",
    "created": true
  }
}
```

Errors:

- `400` missing path or content, or invalid path
- `401` authentication required
- `403` agent/admin/owner role required
- `409` file already exists (use `PUT` to update)
- `503` OpenClaw service not configured or unavailable

### PUT `/openclaw/workspace/files`

Update an existing file (admin/owner only). **Fails if file does not exist** - use `POST` to create new files.

Request body:

```json
{
  "path": "/existing-file.txt",
  "content": "updated content",
  "encoding": "utf8"
}
```

Response `200`:

```json
{
  "data": {
    "path": "/existing-file.txt",
    "updated": true
  }
}
```

Errors:

- `400` missing path or content, or invalid path
- `401` authentication required
- `403` agent/admin/owner role required
- `404` file not found (use `POST` to create)
- `503` OpenClaw service not configured or unavailable

### DELETE `/openclaw/workspace/files`

Delete a file (admin/owner only).

Query parameters:

- `path` (required): workspace file path to delete

Response `204` with no body.

Errors:

- `400` missing or invalid path
- `401` authentication required
- `403` agent/admin/owner role required
- `404` file not found
- `503` OpenClaw service not configured or unavailable

### GET `/openclaw/workspace/status`

Get workspace sync status (all authenticated users).

Response `200`:

```json
{
  "data": {
    "status": "synced",
    "last_sync": "2026-02-05T12:34:56.789Z",
    "workspace_path": "/workspace"
  }
}
```

Errors:

- `401` authentication required
- `503` OpenClaw service not configured or unavailable

### GET `/openclaw/subagents`

Get running, queued, and completed subagents from OpenClaw workspace runtime files (all authenticated users).

This endpoint aggregates subagent status by reading runtime files from the OpenClaw workspace:

- `runtime/mosbot/spawn-active.jsonl` - Currently running subagents
- `runtime/mosbot/spawn-requests.json` - Queued spawn requests
- `runtime/mosbot/results-cache.jsonl` - Completed subagents with outcomes
- `runtime/mosbot/activity-log.jsonl` - Activity logs for timestamp enrichment

Response `200`:

```json
{
  "data": {
    "running": [
      {
        "sessionKey": "agent:main:cron:abc123",
        "sessionLabel": "mosbot-task-550e8400-e29b-41d4-a716-446655440000",
        "taskId": "550e8400-e29b-41d4-a716-446655440000",
        "taskNumber": 1234,
        "status": "RUNNING",
        "model": "sonnet",
        "startedAt": "2026-02-10T09:21:00Z",
        "timeoutMinutes": 15
      }
    ],
    "queued": [
      {
        "taskId": "650e8400-e29b-41d4-a716-446655440001",
        "taskNumber": 1235,
        "title": "Test display token usage",
        "status": "SPAWN_QUEUED",
        "model": "sonnet",
        "queuedAt": "2026-02-10T05:33:58Z"
      }
    ],
    "completed": [
      {
        "sessionLabel": "mosbot-task-750e8400-e29b-41d4-a716-446655440002",
        "taskId": "750e8400-e29b-41d4-a716-446655440002",
        "taskNumber": 1236,
        "status": "COMPLETED",
        "outcome": "✅ Task Complete: Successfully implemented feature",
        "startedAt": "2026-02-09T09:43:58Z",
        "completedAt": "2026-02-09T09:56:19Z",
        "durationSeconds": 742
      }
    ],
    "retention": {
      "completedRetentionDays": 30,
      "activityLogRetentionDays": 7,
      "nextPurgeAt": "2026-02-11T03:00:00Z"
    }
  }
}
```

Response fields:

- `running[]` - Currently active subagents from `spawn-active.jsonl`
  - `taskNumber` - Human-readable task number (e.g., 1234 for TASK-1234), null if task not found
- `queued[]` - Pending spawn requests with `status: "SPAWN_QUEUED"` from `spawn-requests.json`
  - `taskNumber` - Human-readable task number (e.g., 1235 for TASK-1235), null if task not found
- `completed[]` - Finished subagents from `results-cache.jsonl`, deduplicated by `sessionLabel` (latest `cachedAt` wins)
  - `taskNumber` - Human-readable task number (e.g., 1236 for TASK-1236), null if task not found
- `retention` - Data retention policy information

**Data retention**: The API automatically purges old subagent data on a daily schedule (3 AM Asia/Singapore by default):

- Completed subagents older than `completedRetentionDays` (default 30 days) are removed from `results-cache.jsonl`
- Activity logs older than `activityLogRetentionDays` (default 7 days) are removed from `activity-log.jsonl`
- If `RETENTION_ARCHIVE_ENABLED=true`, purged entries are archived to `/runtime/mosbot/archive/` before deletion

**Configuration environment variables**:

- `SUBAGENT_RETENTION_DAYS` - Days to retain completed subagents (default 30)
- `ACTIVITY_LOG_RETENTION_DAYS` - Days to retain activity logs (default 7)
- `RETENTION_ARCHIVE_ENABLED` - Archive purged entries before deletion (default true)
- `ENABLE_SUBAGENT_RETENTION_PURGE` - Enable automatic retention purge (default true)
- `SUBAGENT_RETENTION_CRON` - Cron schedule for purge job (default `0 3 * * *`)

**Notes**:

- Files are read from OpenClaw workspace via the workspace HTTP service
- Missing files are treated gracefully (empty arrays returned, not errors)
- Malformed JSON lines are ignored (the endpoint does not fail)
- `startedAt` and `durationSeconds` for completed subagents are computed best-effort from `activity-log.jsonl` when available; otherwise may be null

Errors:

- `401` authentication required
- `503` OpenClaw service not configured or unavailable

**Retry behavior**: All OpenClaw workspace requests automatically retry up to 3 times with exponential backoff (500ms base delay) for transient errors (timeouts, connection failures, 503 errors).

## Recommended OpenClaw integration flow (example)

1. **Login** with a dedicated Mosbot integration user (`POST /auth/login`).
2. **Cache users** for assignee resolution (`GET /users?active_only=true`).
3. **Optionally cache AI models** for task model selection (`GET /models`). Use the returned `id` values when setting `preferred_model` on tasks.
4. **List tasks** for sync (`GET /tasks?include_archived=true&limit=100&offset=...`).
5. **Create tasks** on demand (`POST /tasks`). Set `preferred_model` to a model `id` from step 3, or omit/null for system default.
6. **Update status/assignee/tags/preferred_model** (`PATCH /tasks/:id`).
7. **Read history** when you need an audit trail (`GET /tasks/:id/history`).
8. **Optional**: Display daily standups (`GET /standups/latest` or `GET /standups/:id`). Standups are triggered by the OpenClaw Scheduler; use `GET /api/v1/config` for the instance timezone.
9. **Optional**: Manually trigger standup collection (`POST /standups/:id/run`) to retry a failed standup or run one off-schedule. Create the standup record first with `POST /standups` if it does not yet exist.

## Quick Reference: All Endpoints

### Public Endpoints (No Auth)

- `GET /health` - Health check
- `GET /api/v1/config` - Instance config (timezone)

### Authentication

- `POST /api/v1/auth/login` - Login and get JWT
- `GET /api/v1/auth/me` - Get current user
- `POST /api/v1/auth/verify` - Verify JWT

### AI Models (Authenticated)

- `GET /api/v1/models` - List available AI models for task execution (use `id` for `preferred_model`)

### Tasks (Authenticated)

- `GET /api/v1/tasks` - List tasks
- `GET /api/v1/tasks/:id` - Get single task by UUID
- `GET /api/v1/tasks/key/:key` - Get single task by key (e.g., TASK-1234)
- `POST /api/v1/tasks` - Create task
- `PUT /api/v1/tasks/:id` - Update task (full)
- `PATCH /api/v1/tasks/:id` - Update task (partial)
- `DELETE /api/v1/tasks/:id` - Delete task
- `GET /api/v1/tasks/:id/history` - Get task history
- `GET /api/v1/tasks/:id/activity` - Get task activity
- `GET /api/v1/tasks/:id/comments` - List task comments
- `POST /api/v1/tasks/:id/comments` - Create comment (auth required)
- `PATCH /api/v1/tasks/:taskId/comments/:commentId` - Update comment (author or admin/owner)
- `DELETE /api/v1/tasks/:taskId/comments/:commentId` - Delete comment (author or admin/owner)
- `GET /api/v1/tasks/:id/subtasks` - Get subtasks (children) of a task
- `GET /api/v1/tasks/:id/dependencies` - Get task dependencies
- `POST /api/v1/tasks/:id/dependencies` - Add a dependency
- `DELETE /api/v1/tasks/:id/dependencies/:dependsOnId` - Remove a dependency

### Users (Authenticated)

- `GET /api/v1/users` - List users
- `GET /api/v1/users/:id` - Get single user

### Admin Users (Admin/Owner Only)

- `GET /api/v1/admin/users` - List all users (with role/active)
- `GET /api/v1/admin/users/:id` - Get single user (with role/active)
- `POST /api/v1/admin/users` - Create user
- `PUT /api/v1/admin/users/:id` - Update user
- `DELETE /api/v1/admin/users/:id` - Delete user

### Activity Logs (Authenticated)

- `GET /api/v1/activity` - List activity logs

### Standups (Authenticated)

- `GET /api/v1/standups` - List standups (newest first)
- `GET /api/v1/standups/latest` - Get most recent standup
- `GET /api/v1/standups/:id` - Get standup with entries and transcript
- `GET /api/v1/standups/:id/entries` - List standup entries
- `GET /api/v1/standups/:id/messages` - List all transcript messages (all kinds)
- `POST /api/v1/standups` - Create standup record (admin)
- `PATCH /api/v1/standups/:id` - Update standup (admin)
- `DELETE /api/v1/standups/:id` - Delete standup (admin, cascades entries + messages)
- `POST /api/v1/standups/:id/run` - Run standup collection via OpenClaw (admin)
- `POST /api/v1/standups/:id/entries` - Add standup entry (admin)
- `PATCH /api/v1/standups/:id/entries/:entryId` - Update standup entry (admin)
- `DELETE /api/v1/standups/:id/entries/:entryId` - Delete standup entry (admin)
- `POST /api/v1/standups/:id/messages` - Add transcript message (admin)
- `DELETE /api/v1/standups/:id/messages/:messageId` - Delete transcript message (admin)

### OpenClaw Workspace (Authenticated)

- `GET /api/v1/openclaw/workspace/files` - List files (all users)
- `GET /api/v1/openclaw/workspace/files/content` - Read file (admin/owner)
- `POST /api/v1/openclaw/workspace/files` - Create file (admin/owner, fails if exists)
- `PUT /api/v1/openclaw/workspace/files` - Update file (admin/owner, fails if not exists)
- `DELETE /api/v1/openclaw/workspace/files` - Delete file (admin/owner)
- `GET /api/v1/openclaw/workspace/status` - Get sync status (all users)
- `GET /api/v1/openclaw/subagents` - Get running/queued/completed subagents (all users)
