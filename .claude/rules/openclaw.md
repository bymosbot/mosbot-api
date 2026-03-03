---
paths:
  - "src/routes/openclaw.js"
  - "src/services/openclawGatewayClient.js"
  - "src/services/openclawWorkspaceClient.js"
  - "src/services/__tests__/openclawGatewayClient.test.js"
  - "src/services/__tests__/openclawWorkspaceClient.test.js"
  - "src/routes/__tests__/openclaw.routes.test.js"
  - "src/routes/__tests__/openclaw.subagents.test.js"
---

# OpenClaw Integration

## Request flow

```
User → MosBot API (JWT auth) → Workspace Service (optional bearer token)
```

MosBot API acts as the authenticated gateway — it never exposes the workspace service directly.

## Endpoint conventions

- Base path: `/api/v1/openclaw/workspace/*`
- Requires JWT authentication (same as all protected endpoints)
- Standard response envelope: `{ data: ... }`

### Workspace endpoints

| Method | Path | Params |
| ------ | ---- | ------ |
| GET | `/workspace/files` | `path`, `recursive` (query) |
| GET | `/workspace/files/content` | `path` (query, required) |
| POST | `/workspace/files` | `path`, `content` (body) |
| PUT | `/workspace/files` | `path`, `content` (body) |
| DELETE | `/workspace/files` | `path` (query) |
| GET | `/workspace/status` | — |

## Path security

Always validate and normalize paths before forwarding — block `..` sequences:

```javascript
function validateWorkspacePath(requestedPath) {
  const normalized = path.normalize(requestedPath);
  if (normalized.includes('..')) throw new Error('Path traversal not allowed');
  return normalized.startsWith('/') ? normalized : '/' + normalized;
}
```

- Paths must stay within the `/workspace` boundary.
- Log all workspace operations with user attribution.

## Configuration

| Env var | Required | Purpose |
| ------- | -------- | ------- |
| `OPENCLAW_WORKSPACE_URL` | Yes | URL of the workspace service |
| `OPENCLAW_WORKSPACE_TOKEN` | No | Bearer token for service-to-service auth |

- Features degrade gracefully when `OPENCLAW_WORKSPACE_URL` is unset.
- Never hardcode the service URL — always read from `process.env`.

## Error handling

- Use standard error shape: `{ error: { message, status } }`
- Handle connection failures gracefully — return `503` with a clear message.
- Return `404` for missing files, `500` for unexpected service errors.

## Related docs

- `docs/api/openclaw-public-api.md` — public API contract
- `docs/openclaw/workspace/` — canonical workspace docs
