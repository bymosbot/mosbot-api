# Task Comments Feature

## Overview

Task comments allow users to have threaded discussions on individual tasks. All comment actions (create, update, delete) are logged to the `task_logs` table for audit purposes.

## Database Schema

### `task_comments` Table

```sql
CREATE TABLE task_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author_id UUID REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT check_body_not_empty CHECK (trim(body) != ''),
    CONSTRAINT check_body_length CHECK (char_length(body) <= 5000)
);
```

**Indexes:**
- `idx_task_comments_task_created` on `(task_id, created_at ASC)` - for efficient comment listing
- `idx_task_comments_author_id` on `(author_id)` - for author lookups

## API Endpoints

### List Comments

```
GET /api/v1/tasks/:id/comments
```

**Query Parameters:**
- `limit` (optional, default: 100) - Max comments to return
- `offset` (optional, default: 0) - Pagination offset

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "task_id": "uuid",
      "author_id": "uuid",
      "author_name": "John Doe",
      "author_email": "john@example.com",
      "author_avatar": "https://...",
      "body": "Comment text",
      "created_at": "2024-01-01T12:00:00Z",
      "updated_at": "2024-01-01T12:00:00Z"
    }
  ],
  "pagination": {
    "limit": 100,
    "offset": 0,
    "total": 1
  }
}
```

### Create Comment

```
POST /api/v1/tasks/:id/comments
```

**Authentication:** Required

**Request Body:**
```json
{
  "body": "Comment text (1-5000 characters)"
}
```

**Response:** `201 Created` with comment data

**Audit Log:** Creates `task_logs` entry with:
- `event_type`: `COMMENT_CREATED`
- `meta.comment_id`: Comment UUID
- `meta.comment_body`: Comment text

### Update Comment

```
PATCH /api/v1/tasks/:taskId/comments/:commentId
```

**Authentication:** Required

**Authorization:** Only the comment author OR admin/owner can edit

**Request Body:**
```json
{
  "body": "Updated comment text"
}
```

**Response:** `200 OK` with updated comment data

**Audit Log:** Creates `task_logs` entry with:
- `event_type`: `COMMENT_UPDATED`
- `old_values.comment_body`: Original text
- `new_values.comment_body`: Updated text
- `meta.comment_id`: Comment UUID

### Delete Comment

```
DELETE /api/v1/tasks/:taskId/comments/:commentId
```

**Authentication:** Required

**Authorization:** Only the comment author OR admin/owner can delete

**Response:** `204 No Content`

**Audit Log:** Creates `task_logs` entry with:
- `event_type`: `COMMENT_DELETED`
- `old_values.comment_body`: Deleted comment text
- `meta.comment_id`: Comment UUID

## Authorization Rules

| Action | Author | Admin | Owner | Regular User |
|--------|--------|-------|-------|--------------|
| Create | ✓      | ✓     | ✓     | ✓            |
| Read   | ✓      | ✓     | ✓     | ✓            |
| Edit   | ✓ (own)| ✓ (any)| ✓ (any)| ✗           |
| Delete | ✓ (own)| ✓ (any)| ✓ (any)| ✗           |

## Frontend Implementation

### Components

**TaskModal.jsx** - Main task detail modal with Comments tab

**Features:**
- Lazy-loaded comments (fetched when Comments tab is clicked)
- Add comment composer with character counter (0/5000)
- Comment list with author info and timestamps
- Inline edit mode for authorized users
- Delete confirmation dialog
- Loading/empty/error states
- Real-time UI updates after mutations

**UI Elements:**
- Edit button (pencil icon) - visible only to author or admin/owner
- Delete button (trash icon) - visible only to author or admin/owner
- Inline edit form with Save/Cancel buttons
- Character counter for comment body
- Loading spinners for async operations

### State Management

Comments are managed locally in `TaskModal` component state:
- `comments` - Array of comment objects
- `loadingComments` - Boolean for initial load
- `commentsLoaded` - Boolean flag to prevent re-fetching
- `commentDraft` - String for new comment input
- `editingCommentId` - UUID of comment being edited (null if none)
- `editingCommentBody` - String for edit input
- `isPostingComment` - Boolean for create operation
- `isUpdatingComment` - Boolean for update operation
- `isDeletingCommentId` - UUID of comment being deleted (null if none)

### Authorization Checks

Frontend checks current user against comment author:
```javascript
const isAuthor = currentUser?.id === comment.author_id;
const isAdminOrOwner = currentUser?.role === 'admin' || currentUser?.role === 'owner';
const canEdit = isAuthor || isAdminOrOwner;
```

## Testing

### Unit Tests

`src/routes/__tests__/tasks-comments.test.js` - 15 tests covering:
- GET endpoint (404 handling, successful list)
- POST endpoint (auth required, validation, successful create)
- PATCH endpoint (auth, 404, authorization, successful edit by author/admin)
- DELETE endpoint (auth, 404, authorization, successful delete by author/owner)

All tests use mocked database pool and verify proper authorization checks.

## Migration

**File:** `src/db/migrations/002_task_comments.sql`

Run migrations with:
```bash
npm run migrate
```

The migration is idempotent and safe to run multiple times.

## Future Enhancements

Potential improvements:
- [ ] Markdown support in comment body
- [ ] @mentions with notifications
- [ ] Comment reactions (emoji)
- [ ] File attachments
- [ ] Edit history tracking
- [ ] Soft delete with restore capability
- [ ] Comment threading (replies)
