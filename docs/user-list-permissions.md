# User List Viewing Permissions

## Overview

Updated the admin users endpoint to allow all authenticated users to view the user list, while keeping create/update/delete operations restricted to agent/admin/owner roles only.

## Changes Made

### Backend API (`src/routes/admin/users.js`)

**Before:**

```javascript
// Apply auth middleware to all routes
router.use(authenticateToken);
router.use(requireAdmin);  // ← Applied to ALL routes
```

**After:**

```javascript
// Apply auth middleware to all routes
router.use(authenticateToken);  // ← Only authentication required

// Individual routes now specify requireAdmin where needed:
router.get('/', async ...)              // ← No requireAdmin (all users can view)
router.get('/:id', async ...)           // ← No requireAdmin (all users can view)
router.post('/', requireAdmin, async ...)     // ← Admin only
router.put('/:id', requireAdmin, async ...)   // ← Admin only
router.delete('/:id', requireAdmin, async ...) // ← Admin only
```

## Permission Model

### What Regular Users CAN Do ✓

- View list of all users (`GET /api/v1/admin/users`)
- View specific user details (`GET /api/v1/admin/users/:id`)
- See user names, emails, roles, and status

### What Regular Users CANNOT Do ✗

- Create new users (403 Forbidden)
- Update existing users (403 Forbidden)
- Delete users (403 Forbidden)

### What Admin/Owner Users Can Do ✓

- Everything regular users can do, plus:
- Create new users
- Update existing users
- Delete users (with owner protection rules)

## API Endpoints Summary

| Endpoint | Method | Auth | Role | Purpose |
|----------|--------|------|------|---------|
| `/api/v1/admin/users` | GET | ✓ | **any** | List all users |
| `/api/v1/admin/users/:id` | GET | ✓ | **any** | View specific user |
| `/api/v1/admin/users` | POST | ✓ | admin/owner | Create user |
| `/api/v1/admin/users/:id` | PUT | ✓ | admin/owner | Update user |
| `/api/v1/admin/users/:id` | DELETE | ✓ | admin/owner | Delete user |

## User Experience

### For Regular Users

**Settings Page - User List:**

- ✓ Can see the "User Settings" section
- ✓ Can view list of all users with their details
- ✓ Can see user roles and status
- ✗ No "Add User" button visible
- ✗ No edit/delete buttons on user rows
- ✗ Attempting to create/update/delete returns 403

**Benefits:**

1. **Transparency**: Users can see who else is in the system
2. **Collaboration**: Know who to contact for help
3. **Awareness**: Understand team structure
4. **Self-Service**: Can see own user details without admin help

### For Admin/Owner Users

- Full access to all user management features
- No changes to existing workflow

## Security Considerations

### What's Protected

- **User Passwords**: Never exposed in any endpoint
- **Modification Rights**: Only admin/owner can change users
- **Sensitive Operations**: Create/update/delete require admin role

### What's Visible

- **User Names**: Public within the organization
- **Email Addresses**: Visible to facilitate communication
- **Roles**: Transparent role structure
- **Status**: Active/inactive status visible

### Defense in Depth

1. **Backend Enforcement**: Middleware checks role before processing
2. **Frontend Reflection**: UI hides buttons for unauthorized actions
3. **Clear Errors**: 403 responses with clear messages
4. **Audit Trail**: All operations logged with user ID and role

## Implementation Details

### Middleware Order

```javascript
// Correct order for routes:
router.get('/', async (req, res, next) => {
  // 1. authenticateToken runs (from router.use)
  // 2. Handler executes (no requireAdmin)
});

router.post('/', requireAdmin, async (req, res, next) => {
  // 1. authenticateToken runs (from router.use)
  // 2. requireAdmin runs (from route-specific middleware)
  // 3. Handler executes
});
```

### Error Responses

#### 401 Unauthorized (No Token)

```json
{
  "error": {
    "message": "No token provided",
    "status": 401
  }
}
```

#### 403 Forbidden (Not Admin)

```json
{
  "error": {
    "message": "Admin access required",
    "status": 403
  }
}
```

## Testing

### Manual Testing Steps

1. **Test as Regular User:**

   ```bash
   # Login as regular user
   curl -X POST http://localhost:3000/api/v1/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"user@example.com","password":"password"}'
   
   # Get token from response, then:
   curl -X GET http://localhost:3000/api/v1/admin/users \
     -H "Authorization: Bearer <token>"
   # Expected: 200 OK with user list
   
   curl -X POST http://localhost:3000/api/v1/admin/users \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{"name":"Test","email":"test@example.com","password":"password123"}'
   # Expected: 403 Forbidden
   ```

2. **Test as Admin:**

   ```bash
   # Login as admin
   # All endpoints should work (200/201 responses)
   ```

3. **Test Unauthenticated:**

   ```bash
   curl -X GET http://localhost:3000/api/v1/admin/users
   # Expected: 401 Unauthorized
   ```

### Automated Tests

See `src/routes/__tests__/openclaw.integration.test.js` for similar permission testing patterns.

## Migration Notes

### Immediate Effect

- Regular users gain ability to view user list
- No breaking changes for existing admin/owner users
- No database changes required
- No configuration changes needed

### Frontend Updates Needed

The dashboard should be updated to:

1. Show "User Settings" section to all authenticated users
2. Hide "Add User" button for non-admin users
3. Hide edit/delete buttons on user rows for non-admin users
4. Handle 403 errors gracefully with appropriate messaging

## Consistency with File Access

This change aligns with the file access permission model:

| Feature | Metadata/List Access | Content/Modify Access |
|---------|---------------------|----------------------|
| **Workspace Files** | All users (browse) | Admin/Owner only |
| **User List** | All users (view) | Admin/Owner only |

Both follow the same pattern:

- **Browse/View**: Available to all authenticated users
- **Modify**: Restricted to agent/admin/owner roles

## Related Documentation

- [File Access Control](./file-access-control.md) - Similar permission pattern
- [API Response Conventions](../../../.cursor/rules/api-responses.mdc)
- [Auth JWT Patterns](../../../.cursor/rules/auth-jwt.mdc)

## Future Enhancements

Potential improvements:

1. **Privacy Settings**: Allow users to hide their profile from non-admins
2. **Team Grouping**: Organize users by teams/departments
3. **Contact Information**: Add phone, location, etc.
4. **User Profiles**: Rich profiles with avatars, bio, etc.
5. **Activity Status**: Show online/offline status
