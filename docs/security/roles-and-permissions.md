# Roles and permissions (RBAC)

This doc describes Mosbot API role-based access control at a policy level.

## Roles

- **owner**: highest privilege (typically a single human owner)
- **agent**: elevated role intended for AI agents
- **admin**: legacy elevated role (still fully supported and functional)
- **user**: regular user

## Elevated permissions

Unless otherwise documented, `owner`, `agent`, and `admin` are treated equivalently for authorization checks.

## Policy patterns used in the API

- **Browse vs modify**
  - Some resources allow all authenticated users to **list/browse metadata**.
  - Content reads and mutations are restricted to elevated roles.

## OpenClaw workspace endpoints

High-level intent:

- **List workspace files (metadata)**: any authenticated user
- **Read file content**: elevated roles only
- **Create/update/delete files**: elevated roles only

See also:

- Public API contract: `docs/api/openclaw-public-api.md`

## Admin user endpoints

High-level intent:

- **List users / view user**: any authenticated user (visibility)
- **Create/update/delete**: elevated roles only

## Notes

- Always enforce permissions on the backend. Frontend checks are UX-only.
- Keep the contract in `docs/api/openclaw-public-api.md` aligned with actual behavior.
