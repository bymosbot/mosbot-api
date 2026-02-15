# Agent Role Migration

**Date**: 2026-02-15  
**Status**: Ready for deployment

## Overview

This migration introduces a new `agent` role to replace the `admin` role for AI agents in the Mosbot system. The CEO (Marcelo Oliveira) remains the only `owner`, while all AI agents (COO, CTO, CMO, CPO) are assigned the new `agent` role.

## Motivation

- **Clarity**: Distinguish between AI agents and human administrators
- **Role Hierarchy**: Establish clear separation: Owner (CEO) → Agent (AI) → Admin (deprecated) → User
- **Future-proofing**: Prepare for potential different permission levels between AI agents and human admins

## Changes Summary

### Database Changes

1. **Initial Schema**: `src/db/migrations/001_initial_schema.sql`
   - Added `agent` to the role CHECK constraint
   - AI agent users (COO, CTO, CMO, CPO) created with `agent` role
   - Keeps `admin` role valid for backward compatibility (deprecated)
   - Only CEO created as `owner`
   - Added role hierarchy comment to users.role column

### API Changes

1. **Authentication Middleware** (`src/routes/auth.js`)
   - Updated `requireAdmin` middleware to accept `agent` role
   - Now allows: `admin`, `agent`, `owner`

2. **Admin User Routes** (`src/routes/admin/users.js`)
   - Updated role validation to allow `agent` role assignment
   - Valid roles for creation/update: `agent`, `admin`, `user`
   - `owner` role still protected (cannot be assigned via API)

3. **Task Routes** (`src/routes/tasks.js`)
   - Updated comment edit/delete authorization to include `agent` role
   - Authorization checks now include: `admin`, `agent`, `owner`

### Dashboard Changes

1. **Auth Store** (`src/stores/authStore.js`)
   - Updated `isAdmin()` helper to include `agent` role
   - Returns true for: `admin`, `agent`, `owner`

2. **User Modal** (`src/components/UserModal.jsx`)
   - Added `agent` option to role selector
   - Marked `admin` as deprecated in UI
   - Role options: User, Agent, Admin (deprecated), Owner

3. **Settings Page** (`src/pages/Settings.jsx`)
   - Added blue badge styling for `agent` role
   - Color scheme: Owner (amber), Admin (purple), Agent (blue), User (gray)

4. **Task Modal** (`src/components/TaskModal.jsx`)
   - Updated comment permissions to include `agent` role

### Documentation Updates

- `src/db/migrations/README.md`: Updated role descriptions
- `docs/api/openclaw-public-api.md`: Updated API documentation
- `docs/user-list-permissions.md`: Updated permission descriptions
- `docs/file-access-control.md`: Updated RBAC descriptions
- `docs/features/task-comments.md`: Updated code examples

### Test Updates

- Updated integration tests to include `agent` role scenarios
- Updated unit tests for permission checks
- Updated dashboard component tests

## Role Hierarchy

```
owner (CEO only)
  ↓
agent (AI agents: COO, CTO, CMO, CPO)
  ↓
admin (deprecated, use 'agent' instead)
  ↓
user (regular users)
```

## Permissions

All three elevated roles (`owner`, `agent`, `admin`) have the same permissions:

- ✅ Create/update/delete users
- ✅ Access workspace files
- ✅ Edit/delete any task comments
- ✅ View all system data
- ✅ Access admin endpoints

**Note**: `owner` has additional protections (cannot be deleted, cannot change own role).

## Migration Steps

### 1. Database Reset

Since the changes are consolidated into the initial schema, run a database reset:

```bash
cd mosbot-api
npm run db:reset
```

This will:
- Drop and recreate the database
- Create users table with `agent` role in constraint
- Create COO, CTO, CMO, CPO with `agent` role
- Create CEO with `owner` role

### 2. Verify Migration

Check the database:

```sql
SELECT name, email, role FROM users WHERE email LIKE '%@mosbot.local';
```

Expected output:
```
Marcelo Oliveira | ceo@mosbot.local | owner
MosBot           | coo@mosbot.local | agent
Elon             | cto@mosbot.local | agent
Gary             | cmo@mosbot.local | agent
Alex             | cpo@mosbot.local | agent
```

### 3. Deploy API

Deploy the updated API with the new middleware and route changes.

### 4. Deploy Dashboard

Deploy the updated dashboard with the new UI components.

### 5. Test

1. Login as CEO (owner) - should have full access
2. Login as COO/CTO/CMO/CPO (agent) - should have admin access
3. Create a new user with `agent` role - should succeed
4. Verify role badges display correctly in Settings page
5. Test comment edit/delete permissions

## Backward Compatibility

- ✅ `admin` role remains valid in the database
- ✅ Existing `admin` users will continue to work
- ✅ API accepts `admin` role in requests
- ⚠️ UI marks `admin` as deprecated, encouraging use of `agent`

## Future Considerations

- Consider removing `admin` role entirely in a future major version
- May introduce different permission levels for `agent` vs `admin` if needed
- Could add more granular role-based permissions (e.g., `read-only-agent`)

## Rollback Plan

If issues arise, rollback by:

1. Revert database migration:
   ```sql
   UPDATE users SET role = 'admin' WHERE role = 'agent';
   ALTER TABLE users DROP CONSTRAINT valid_role;
   ALTER TABLE users ADD CONSTRAINT valid_role 
       CHECK (role IN ('owner', 'admin', 'user'));
   ```

2. Revert API and dashboard code changes

3. Redeploy previous versions

## Files Changed

### API (mosbot-api)
- `src/db/migrations/002_add_agent_role.sql` (new)
- `src/db/migrations/001_initial_schema.sql`
- `src/db/migrations/README.md`
- `src/routes/auth.js`
- `src/routes/admin/users.js`
- `src/routes/tasks.js`
- `src/routes/admin/__tests__/users.integration.test.js`
- `src/routes/admin/__tests__/users-permissions.test.js`
- `docs/api/openclaw-public-api.md`
- `docs/user-list-permissions.md`
- `docs/file-access-control.md`
- `docs/features/task-comments.md`

### Dashboard (mosbot-dashboard)
- `src/stores/authStore.js`
- `src/stores/authStore.test.js`
- `src/components/UserModal.jsx`
- `src/components/TaskModal.jsx`
- `src/pages/Settings.jsx`
- `src/pages/Settings.test.jsx`

## Questions?

Contact the development team for any questions or issues related to this migration.
