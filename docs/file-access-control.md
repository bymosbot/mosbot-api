# File Access Control Implementation

## Overview

This document describes the role-based access control (RBAC) implementation for OpenClaw workspace file operations. Access to view and modify workspace files is now restricted to users with `agent`, `admin` or `owner` roles.

## Changes Made

### Backend API Changes

#### 1. File Listing Endpoint (`GET /api/v1/openclaw/workspace/files`)

**Before:**

- Required authentication only (`requireAuth`)
- Any authenticated user could list workspace files

**After:**

- Requires authentication (`requireAuth`)
- All authenticated users can list workspace files and view metadata
- Returns file names, sizes, types, modification dates
- Does NOT return file contents (content requires separate endpoint)

#### 2. File Content Reading Endpoint (`GET /api/v1/openclaw/workspace/files/content`)

**Before:**

- Required authentication only (`requireAuth`)
- Any authenticated user could read file contents

**After:**

- Requires authentication AND admin role (`requireAuth`, `requireAdmin`)
- Only `agent`, `admin` and `owner` roles can read file contents
- Regular users receive `403 Forbidden` response

#### 3. Write Operations (Already Protected)

The following endpoints were already protected with `requireAdmin`:

- `POST /api/v1/openclaw/workspace/files` - Create file
- `PUT /api/v1/openclaw/workspace/files` - Update file
- `DELETE /api/v1/openclaw/workspace/files` - Delete file

### Frontend Changes

#### 1. FilePreview Component (`src/components/FilePreview.jsx`)

**Access Denied UI:**

- Detects `403 Forbidden` errors from API
- Shows a "mosaic" pattern background with blurred effect
- Displays a centered permission message with:
  - Lock icon in yellow
  - "File Access Restricted" heading
  - Explanation text
  - Instructions to contact an administrator

**Error Handling:**

- Suppresses toast notifications for 403 errors
- Shows restricted view instead of generic error message
- Maintains normal error handling for other error types

#### 2. WorkspaceExplorer Component (`src/components/WorkspaceExplorer.jsx`)

**Error Handling:**

- Suppresses toast notifications for 403 errors on:
  - Initial file listing load
  - Manual refresh operations
  - On-demand folder expansion
- Allows error banner to display the access denied message
- Maintains normal error handling for other error types

### Testing

#### Integration Tests (`src/routes/__tests__/openclaw.integration.test.js`)

Comprehensive test suite covering:

**File Listing Tests:**

- ✓ Owner can list files
- ✓ Admin can list files
- ✓ Regular user can list files (metadata only)
- ✓ Unauthenticated user receives 401
- ✓ Invalid token receives 401

**File Content Reading Tests:**

- ✓ Owner can read file content
- ✓ Admin can read file content
- ✓ Regular user receives 403
- ✓ Unauthenticated user receives 401
- ✓ Path parameter validation

**File Creation Tests:**

- ✓ Owner can create files
- ✓ Admin can create files
- ✓ Regular user receives 403

**File Update Tests:**

- ✓ Owner can update files
- ✓ Admin can update files
- ✓ Regular user receives 403

**File Deletion Tests:**

- ✓ Owner can delete files
- ✓ Admin can delete files
- ✓ Regular user receives 403

**Status Check Tests:**

- ✓ Any authenticated user can check status
- ✓ Unauthenticated user receives 401

**Test Results:** All 21 tests passing ✓

## Security Model

### Role Hierarchy

1. **Owner** (highest privilege)
   - Full access to all workspace operations
   - Can list files, read content, create, update, and delete files

2. **Admin**
   - Full access to all workspace operations
   - Can list files, read content, create, update, and delete files

3. **User** (lowest privilege)
   - **Can** list workspace files and view metadata (name, size, date)
   - **Cannot** read file contents (403 Forbidden)
   - **Cannot** create, update, or delete files (403 Forbidden)
   - Can still access other application features (tasks, etc.)

### Authentication Flow

**File Listing (metadata only):**

```
Request → requireAuth → OpenClaw Service
           ↓ (401)         ↓ (200/error)
        Unauthorized     Success/Error
```

**File Content & Modifications:**

```
Request → requireAuth → requireAdmin → OpenClaw Service
           ↓ (401)        ↓ (403)         ↓ (200/error)
        Unauthorized   Forbidden        Success/Error
```

### Error Responses

#### 401 Unauthorized

```json
{
  "error": {
    "message": "Authorization required",
    "status": 401
  }
}
```

#### 403 Forbidden

```json
{
  "error": {
    "message": "Admin access required",
    "status": 403
  }
}
```

## User Experience

### Admin/Owner Users

- Full access to workspace files
- Can browse, view, edit, create, and delete files
- No changes to existing workflow

### Regular Users

Partial access to workspace files:

1. **File Listing (✓ Allowed):**
   - Can browse the file tree
   - Can see file names, sizes, types
   - Can see modification dates
   - Can expand folders and navigate the workspace structure
   - Full navigation experience, just like admin/owner

2. **File Content (✗ Restricted):**
   When clicking on a file to view its content:
   - Mosaic pattern background (blurred, low opacity)
   - Centered permission card with:
     - Yellow lock icon
     - "File Access Restricted" heading
     - Explanation: "You don't have permission to view the contents of this file."
     - Instructions: "To request access, please contact an administrator of this application."

3. **File Modifications (✗ Restricted):**
   - No "New File" or "New Folder" buttons visible
   - No edit, rename, or delete options in context menu
   - All modification operations return 403 Forbidden

### Unauthenticated Users

- Redirected to login page
- Cannot access any workspace endpoints

## API Endpoints Summary

| Endpoint | Method | Auth | Role | Purpose |
|----------|--------|------|------|---------|
| `/api/v1/openclaw/workspace/files` | GET | ✓ | **any** | List files (metadata only) |
| `/api/v1/openclaw/workspace/files/content` | GET | ✓ | admin/owner | Read file content |
| `/api/v1/openclaw/workspace/files` | POST | ✓ | admin/owner | Create file |
| `/api/v1/openclaw/workspace/files` | PUT | ✓ | admin/owner | Update file |
| `/api/v1/openclaw/workspace/files` | DELETE | ✓ | admin/owner | Delete file |
| `/api/v1/openclaw/workspace/status` | GET | ✓ | any | Check status |

## Migration Notes

### Existing Users

- Users with `user` role can browse files and see metadata, but cannot read content
- No data migration required
- Admin/owner users are unaffected

### Configuration

No configuration changes required. The access control is enforced at the middleware level using existing role information from JWT tokens.

## Future Enhancements

Potential improvements for consideration:

1. **Granular Permissions:**
   - Read-only access for specific users
   - Path-based permissions (e.g., user can only access `/public/*`)

2. **Audit Logging:**
   - Log all file access attempts
   - Track who accessed which files and when

3. **Permission Request Flow:**
   - Allow users to request access
   - Notify admins of access requests
   - Approval workflow

4. **Team-based Access:**
   - Group users into teams
   - Grant file access per team

## Compliance

This implementation follows security best practices:

- ✓ Defense in depth (backend + frontend validation)
- ✓ Principle of least privilege (deny by default)
- ✓ Secure by default (requires explicit admin role)
- ✓ Clear error messages (without leaking sensitive info)
- ✓ Comprehensive test coverage
- ✓ Consistent with existing auth patterns

## References

- [OpenClaw Integration Guide](./openclaw-integration.md)
- [Authentication Guide](./auth-guide.md)
- [API Response Conventions](../../../.cursor/rules/api-responses.mdc)
- [Auth JWT Patterns](../../../.cursor/rules/auth-jwt.mdc)
