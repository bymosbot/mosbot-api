# OpenClaw local development

This guide covers running Mosbot API locally while connecting to OpenClaw services (workspace + gateway) via `kubectl port-forward`.

## When you need this

- Agent auto-discovery (`GET /api/v1/openclaw/agents`)
- Workspace file access (`/api/v1/openclaw/workspace/*`)
- Gateway-backed runtime endpoints (if enabled in your setup)

## Prerequisites

- OpenClaw deployed in Kubernetes
- `kubectl` configured to access the cluster
- Two terminals for port-forwards (recommended)

## 1) Get tokens (Kubernetes)

Mosbot API expects tokens for OpenClaw services. Your secrets/namespace names may differ; adjust as needed.

```bash
# Workspace service token
kubectl get secret -n openclaw-personal openclaw-secrets \
  -o jsonpath='{.data.WORKSPACE_SERVICE_TOKEN}' | base64 -d && echo

# Gateway token (if used)
kubectl get secret -n openclaw-personal openclaw-secrets \
  -o jsonpath='{.data.OPENCLAW_GATEWAY_TOKEN}' | base64 -d && echo
```

## 2) Port-forward services

```bash
# Terminal 1: Workspace service
kubectl port-forward -n openclaw-personal svc/openclaw-workspace 8080:8080

# Terminal 2: Gateway service (if used)
kubectl port-forward -n openclaw-personal svc/openclaw 18789:18789
```

## 3) Configure `.env`

If running the API natively on your host:

```bash
OPENCLAW_WORKSPACE_URL=http://localhost:8080
OPENCLAW_GATEWAY_URL=http://localhost:18789
OPENCLAW_WORKSPACE_TOKEN=<workspace-token>
OPENCLAW_GATEWAY_TOKEN=<gateway-token>
```

If running the API in Docker, prefer `host.docker.internal` for the forwarded ports:

```bash
OPENCLAW_WORKSPACE_URL=http://host.docker.internal:8080
OPENCLAW_GATEWAY_URL=http://host.docker.internal:18789
```

## 4) Restart the API

```bash
npm run dev
```

## 5) Verify

### Agents (auto-discovery)

```bash
curl http://localhost:3000/api/v1/openclaw/agents
```

### Workspace service connectivity (direct)

```bash
curl -H "Authorization: Bearer <workspace-token>" http://localhost:8080/status
```

## Troubleshooting

- **503 errors**: port-forward stopped or service restarted
- **Connection refused**: wrong namespace/service name or port-forward not running
- **401 unauthorized**: token mismatch/expired (production)
- **Only seeing default agent**: API cannot reach workspace service; verify `OPENCLAW_WORKSPACE_URL`

