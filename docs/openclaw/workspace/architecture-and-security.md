# OpenClaw workspace integration: architecture and security

## Architecture (overview)

Mosbot exposes OpenClaw workspace file access via:

```bash
User (JWT) -> Mosbot API -> Workspace Service (sidecar) -> PVC filesystem
```

- The **workspace service** runs inside the OpenClaw pod and has access to the same PVC.
- Mosbot API talks to the workspace service via internal networking (ClusterIP) or via port-forward in development.

## Security model (defense in depth)

- **Network isolation**: workspace service should be ClusterIP-only (no public ingress)
- **User auth**: Mosbot API endpoints use JWT (same as other API routes)
- **Service-to-service auth (optional)**: Mosbot API can send a bearer token to the workspace service
- **Path validation**: normalize and reject traversal attempts (e.g. `..`)
- **RBAC**: content reads and writes are restricted to elevated roles

## Create vs update semantics (important)

To avoid accidental overwrites:

- **Create** should fail with **409 Conflict** if the file already exists
- **Update** should fail with **404 Not Found** if the file does not exist

If the workspace service supports atomic create (e.g. Node `fs.open(path, 'wx')`), it should be used to avoid race-condition overwrites.

## Related

- Public API contract: `docs/api/openclaw-public-api.md`
- RBAC policy: `docs/security/roles-and-permissions.md`
