# OpenClaw Workspace Integration

This document describes how MosBot integrates with OpenClaw's workspace files via HTTP API.

## Architecture Overview

```bash
┌─────────────────┐         ┌──────────────────────┐
│  MosBot API     │         │  OpenClaw Pod        │
│                 │         │                      │
│  /api/v1/       │  HTTP   │  ┌────────────────┐  │
│  openclaw/      │────────▶│  │ Workspace      │  │
│  workspace/*    │         │  │ Service        │  │
│                 │         │  │ (Sidecar)      │  │
└─────────────────┘         │  └────────┬───────┘  │
                            │           │          │
                            │           │ mount    │
                            │           ▼          │
                            │  ┌────────────────┐  │
                            │  │ PVC (Longhorn) │  │
                            │  │ /workspace     │  │
                            │  └────────────────┘  │
                            │           ▲          │
                            │           │ mount    │
                            │  ┌────────┴───────┐  │
                            │  │ OpenClaw       │  │
                            │  │ Agent          │  │
                            │  └────────────────┘  │
                            └──────────────────────┘
```

## Components

### 1. MosBot API Routes (`/api/v1/openclaw`)

New API endpoints in MosBot for accessing OpenClaw workspace files:

- `GET /workspace/files` - List workspace files
- `GET /workspace/files/content` - Read file content
- `POST /workspace/files` - Create file
- `PUT /workspace/files` - Update file
- `DELETE /workspace/files` - Delete file
- `GET /workspace/status` - Get workspace status

### 2. OpenClaw Workspace Service (Sidecar)

Lightweight Node.js HTTP service that:

- Runs as a sidecar container in the OpenClaw pod
- Mounts the same PVC as OpenClaw (read-only for safety)
- Exposes workspace files via REST API
- Handles path validation and security
- Supports optional bearer token authentication

### 3. Shared Storage

OpenClaw's existing Longhorn PVC is mounted to both:

- OpenClaw agent container at `/home/node/.openclaw` (read-write)
- Workspace service at `/workspace` (read-only)

## Setup Instructions

### Step 1: Build and Push Workspace Service Image

```bash
cd /Users/mosufy/Documents/webapps/Homelab/homelab-gitops/apps/homelab/openclaw/workspace-service

# Build and push to GHCR
./build-and-push.sh 1.0.0

# Or build locally for testing
docker build -t openclaw-workspace-service:latest .
```

### Step 2: Configure Secrets

#### OpenClaw Secret (Optional)

Add workspace service token to OpenClaw secrets:

```bash
# Generate a secure token
WORKSPACE_TOKEN=$(openssl rand -base64 32)

# Add to OpenClaw secret
kubectl create secret generic openclaw-secrets \
  --from-literal=WORKSPACE_SERVICE_TOKEN="${WORKSPACE_TOKEN}" \
  --namespace=agents \
  --dry-run=client -o yaml | kubectl apply -f -
```

#### MosBot API Secret

Add the same token to MosBot API secrets:

```bash
# Base64 encode the token
echo -n "${WORKSPACE_TOKEN}" | base64

# Add to mosbot-api-secrets
kubectl edit secret mosbot-api-secrets -n mosbot
# Add: OPENCLAW_WORKSPACE_TOKEN: <base64-encoded-token>
```

### Step 3: Deploy Updated OpenClaw

The OpenClaw deployment now includes the workspace service sidecar:

```bash
cd /Users/mosufy/Documents/webapps/Homelab/homelab-gitops/apps/homelab/openclaw

# Apply the updated deployment
kubectl apply -k overlays/personal/  # or homelab/incube8

# Verify both containers are running
kubectl get pods -n openclaw-personal
kubectl logs -n openclaw-personal <pod-name> -c workspace-service
```

### Step 4: Deploy Updated MosBot API

```bash
cd /Users/mosufy/Documents/webapps/Mosbot/mosbot-api

# Update ConfigMap and Secret as needed
kubectl apply -k k8s/base/

# Restart MosBot API to pick up new config
kubectl rollout restart deployment/mosbot-api -n mosbot
```

### Step 5: Verify Integration

Test the workspace API:

```bash
# Get JWT token
TOKEN=$(curl -X POST http://mosbot-api.mosbot.svc.cluster.local:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@mosbot.local","password":"your-password"}' \
  | jq -r '.data.token')

# List workspace files
curl -H "Authorization: Bearer ${TOKEN}" \
  http://mosbot-api.mosbot.svc.cluster.local:3000/api/v1/openclaw/workspace/files

# Read a file
curl -H "Authorization: Bearer ${TOKEN}" \
  "http://mosbot-api.mosbot.svc.cluster.local:3000/api/v1/openclaw/workspace/files/content?path=/README.md"
```

## API Reference

### List Files

**GET** `/api/v1/openclaw/workspace/files`

Query parameters:

- `path` (optional, default: `/`) - Directory path to list
- `recursive` (optional, default: `false`) - Recursively list subdirectories

Response:

```json
{
  "data": {
    "files": [
      {
        "path": "/README.md",
        "name": "README.md",
        "type": "file",
        "size": 1234,
        "modified": "2026-02-05T12:00:00.000Z",
        "created": "2026-02-01T10:00:00.000Z"
      }
    ],
    "count": 1,
    "path": "/",
    "recursive": false
  }
}
```

### Read File Content

**GET** `/api/v1/openclaw/workspace/files/content`

Query parameters:

- `path` (required) - File path to read
- `encoding` (optional, default: `utf8`) - File encoding

Response:

```json
{
  "data": {
    "path": "/README.md",
    "name": "README.md",
    "type": "file",
    "size": 1234,
    "modified": "2026-02-05T12:00:00.000Z",
    "content": "# OpenClaw Workspace\n...",
    "encoding": "utf8"
  }
}
```

### Create File

**POST** `/api/v1/openclaw/workspace/files`

Request body:

```json
{
  "path": "/notes/meeting.md",
  "content": "# Meeting Notes\n...",
  "encoding": "utf8"
}
```

Response: `201 Created`

```json
{
  "data": {
    "path": "/notes/meeting.md",
    "name": "meeting.md",
    "type": "file",
    "size": 123,
    "modified": "2026-02-05T12:00:00.000Z",
    "message": "File created successfully"
  }
}
```

### Update File

**PUT** `/api/v1/openclaw/workspace/files`

Request body:

```json
{
  "path": "/notes/meeting.md",
  "content": "# Updated Meeting Notes\n...",
  "encoding": "utf8"
}
```

Response: `200 OK`

```json
{
  "data": {
    "path": "/notes/meeting.md",
    "name": "meeting.md",
    "type": "file",
    "size": 145,
    "modified": "2026-02-05T12:30:00.000Z",
    "message": "File updated successfully"
  }
}
```

### Delete File

**DELETE** `/api/v1/openclaw/workspace/files`

Query parameters:

- `path` (required) - File or directory path to delete

Response: `204 No Content`

### Get Workspace Status

**GET** `/api/v1/openclaw/workspace/status`

Response:

```json
{
  "data": {
    "workspace": "/workspace",
    "exists": true,
    "accessible": true,
    "modified": "2026-02-05T12:00:00.000Z"
  }
}
```

## Security Considerations

### Authentication

1. **MosBot API**: Requires JWT authentication (same as other endpoints)
2. **Workspace Service**: Optional bearer token authentication between services

### Path Traversal Protection

The workspace service validates all paths to prevent directory traversal attacks:

- Normalizes paths
- Blocks `..` sequences
- Ensures all paths stay within `/workspace`

### Read-Only Mount

The workspace service mounts the PVC as read-only by default. To enable writes:

1. Change the mount in `deployment.yaml`:

   ```yaml
   - name: state
     mountPath: /workspace
     readOnly: false  # Enable writes
   ```

2. Update file permissions if needed

### Network Security

- Workspace service is only accessible within the cluster (ClusterIP)
- MosBot API acts as the gateway with proper authentication
- No direct external access to workspace files

## Troubleshooting

### Workspace Service Not Starting

Check logs:

```bash
kubectl logs -n openclaw-personal <pod-name> -c workspace-service
```

Common issues:

- PVC not mounted correctly
- Permissions issues (ensure fsGroup: 1000)
- Port conflict

### MosBot API Can't Connect

Check service DNS:

```bash
kubectl run -it --rm debug --image=busybox --restart=Never -- \
  nslookup openclaw-workspace.agents.svc.cluster.local
```

Check connectivity:

```bash
kubectl run -it --rm debug --image=curlimages/curl --restart=Never -- \
  curl http://openclaw-workspace.agents.svc.cluster.local:8080/health
```

### Permission Denied Errors

Ensure both containers run as the same user (1000:1000) and fsGroup is set:

```yaml
securityContext:
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
```

## Future Enhancements

### Phase 2: Real-time Sync

Add webhook support for real-time file change notifications:

- Watch filesystem for changes
- Send webhooks to MosBot API
- Update activity log automatically

### Phase 3: Version Control

Add git-like versioning:

- Track file history
- Diff support
- Rollback capability

### Phase 4: Conflict Resolution

Handle concurrent edits:

- Lock files during editing
- Detect conflicts
- Merge strategies

### Phase 5: Google Drive Sync

Add optional Google Drive integration:

- Bidirectional sync
- Backup to cloud
- Share with external users

## Related Documentation

- [OpenClaw Public API](./openclaw-public-api.md) - Task management API
- [Adapter Interface Proposal](./adapter-interface-proposal.md) - Generic adapter design
- [MosBot API README](../README.md) - Main API documentation
