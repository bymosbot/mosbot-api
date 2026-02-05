# Mosbot Public API (for OpenClaw Integration)

This document describes the **public HTTP API contract** OpenClaw can use to integrate with Mosbot as a task backend.

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
- `title` (string, max 500)
- `summary` (string | null)
- `status` (enum, see below)
- `priority` (`High` | `Medium` | `Low` | null)
- `type` (`task` | `bug` | `feature` | `improvement` | `research`)
- `reporter_id` (uuid | null)
- `assignee_id` (uuid | null)
- `tags` (string[] | null)
- `due_date` (timestamp | null)
- `done_at` (timestamp | null)
- `archived_at` (timestamp | null)
- `created_at` (timestamp)
- `updated_at` (timestamp)

Denormalized/joined fields (may appear on some endpoints):

- `reporter_name`, `reporter_email`, `reporter_avatar`
- `assignee_name`, `assignee_email`, `assignee_avatar`

### Enums

- **Task status**: `PLANNING` | `TO DO` | `IN PROGRESS` | `DONE` | `ARCHIVE`
- **Task priority**: `High` | `Medium` | `Low`
- **Task type**: `task` | `bug` | `feature` | `improvement` | `research`

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
- `event_type` (enum): `CREATED` | `UPDATED` | `STATUS_CHANGED` | `ARCHIVED_AUTO` | `ARCHIVED_MANUAL` | `RESTORED` | `DELETED`
- `occurred_at` (timestamp)
- `actor_id` (uuid | null)
- `source` (enum): `ui` | `api` | `cron` | `system`
- `old_values` (object | null)
- `new_values` (object | null)
- `meta` (object | null)
- `actor_name`, `actor_email`, `actor_avatar` (nullable joined fields)

### Activity log

Returned by `GET /activity` and `GET /tasks/:id/activity`:

- `id` (uuid)
- `timestamp` (timestamp)
- `title` (string, max 500)
- `description` (string)
- `category` (string | null)
- `task_id` (uuid | null)
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

Fetch a single task.

Response `200`:

```json
{ "data": { /* Task */ } }
```

Errors:

- `400` invalid UUID
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
  "tags": ["OpenClaw", "Docs", "API"]
}
```

Behavior notes:

- If `status` is omitted it defaults to `PLANNING`.
- If `type` is omitted it defaults to `task`.
- If `reporter_id` is omitted and a JWT is provided, Mosbot sets `reporter_id` to the authenticated user.
- `tags` are normalized (see rules above).

Response `201`:

```json
{ "data": { /* Task */ } }
```

### PUT `/tasks/:id` (and PATCH `/tasks/:id`)

Update a task. `PATCH` is supported and behaves the same as `PUT`.

You may send any subset of these fields:

- `title`, `summary`, `status`, `priority`, `type`, `reporter_id`, `assignee_id`, `due_date`, `tags`

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

- `400` invalid UUID, invalid enum, invalid tags, or no fields to update
- `404` task not found

### DELETE `/tasks/:id`

Delete a task.

Response `204` with no body.

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

## Recommended OpenClaw integration flow (example)

1. **Login** with a dedicated Mosbot integration user (`POST /auth/login`).
2. **Cache users** for assignee resolution (`GET /users?active_only=true`).
3. **List tasks** for sync (`GET /tasks?include_archived=true&limit=100&offset=...`).
4. **Create tasks** on demand (`POST /tasks`).
5. **Update status/assignee/tags** (`PATCH /tasks/:id`).
6. **Read history** when you need an audit trail (`GET /tasks/:id/history`).
