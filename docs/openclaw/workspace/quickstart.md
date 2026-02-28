# OpenClaw workspace integration (quickstart)

This is the shortest path to getting Mosbot API reading OpenClaw workspace files via the workspace sidecar service.

## What you deploy

- **OpenClaw** pod includes a **workspace service** sidecar exposing the workspace PVC via HTTP (ClusterIP)
- **Mosbot API** calls the workspace service and exposes `/api/v1/openclaw/workspace/*`

## Configure secrets

Generate a token and share it between services (namespaces may differ in your cluster):

```bash
WORKSPACE_TOKEN="$(openssl rand -base64 32)"
echo "Save this token securely: ${WORKSPACE_TOKEN}"
```

## Configure Mosbot API

Set:

- `OPENCLAW_WORKSPACE_URL`
- `OPENCLAW_WORKSPACE_TOKEN`

## Verify

1) Get a Mosbot JWT (login), then:

```bash
curl -H "Authorization: Bearer <MOSBOT_JWT>" \
  "http://localhost:3000/api/v1/openclaw/workspace/status"
```

1) List files:

```bash
curl -H "Authorization: Bearer <MOSBOT_JWT>" \
  "http://localhost:3000/api/v1/openclaw/workspace/files?path=/&recursive=true"
```

## Full docs

- Architecture + security: `docs/openclaw/workspace/architecture-and-security.md`
- Operations + troubleshooting: `docs/openclaw/workspace/operations-and-troubleshooting.md`
