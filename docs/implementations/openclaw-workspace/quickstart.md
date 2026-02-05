# OpenClaw Workspace Integration - Quick Start

Get OpenClaw workspace file access up and running in 5 steps.

## Prerequisites

- OpenClaw deployed in Kubernetes
- MosBot API deployed in Kubernetes
- Docker and kubectl access
- GHCR credentials configured

## Step 1: Build Workspace Service (5 minutes)

```bash
cd /Users/mosufy/Documents/webapps/Homelab/homelab-gitops/apps/homelab/openclaw/workspace-service

# Authenticate with GHCR
echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin

# Build and push
./build-and-push.sh 1.0.0
```

## Step 2: Configure Secrets (2 minutes)

```bash
# Generate workspace token
WORKSPACE_TOKEN=$(openssl rand -base64 32)
echo "Save this token: ${WORKSPACE_TOKEN}"

# Add to OpenClaw secrets
kubectl create secret generic openclaw-secrets \
  --from-literal=WORKSPACE_SERVICE_TOKEN="${WORKSPACE_TOKEN}" \
  --namespace=agents \
  --dry-run=client -o yaml | kubectl apply -f -

# Add to MosBot API secrets
kubectl create secret generic mosbot-api-secrets \
  --from-literal=OPENCLAW_WORKSPACE_TOKEN="${WORKSPACE_TOKEN}" \
  --namespace=mosbot \
  --dry-run=client -o yaml | kubectl apply -f -
```

## Step 3: Deploy OpenClaw with Workspace Service (3 minutes)

```bash
cd /Users/mosufy/Documents/webapps/Homelab/homelab-gitops/apps/homelab/openclaw

# Update image tag in overlays/personal/kustomization.yaml (or homelab/incube8)
# Set: newTag: "1.0.0"

# Apply deployment
kubectl apply -k overlays/personal/

# Wait for pod to be ready
kubectl wait --for=condition=ready pod -l app=openclaw -n openclaw-personal --timeout=300s

# Verify both containers are running
kubectl get pods -n openclaw-personal
kubectl logs -n openclaw-personal -l app=openclaw -c workspace-service --tail=20
```

## Step 4: Deploy MosBot API Update (2 minutes)

```bash
cd /Users/mosufy/Documents/webapps/Mosbot/mosbot-api

# Apply updated ConfigMap and Deployment
kubectl apply -k k8s/base/

# Restart MosBot API
kubectl rollout restart deployment/mosbot-api -n mosbot
kubectl rollout status deployment/mosbot-api -n mosbot
```

## Step 5: Test Integration (3 minutes)

```bash
# Port-forward MosBot API (in a separate terminal)
kubectl port-forward -n mosbot svc/mosbot-api 3000:3000

# Get JWT token
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@mosbot.local","password":"your-password"}' \
  | jq -r '.data.token')

echo "Token: ${TOKEN}"

# Test workspace status
curl -s -H "Authorization: Bearer ${TOKEN}" \
  http://localhost:3000/api/v1/openclaw/workspace/status | jq

# List workspace files
curl -s -H "Authorization: Bearer ${TOKEN}" \
  "http://localhost:3000/api/v1/openclaw/workspace/files?path=/&recursive=true" | jq

# Read a file (adjust path as needed)
curl -s -H "Authorization: Bearer ${TOKEN}" \
  "http://localhost:3000/api/v1/openclaw/workspace/files/content?path=/config.json" | jq
```

## Expected Output

### Workspace Status

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

### List Files

```json
{
  "data": {
    "files": [
      {
        "path": "/config.json",
        "name": "config.json",
        "type": "file",
        "size": 1234,
        "modified": "2026-02-05T12:00:00.000Z"
      }
    ],
    "count": 1,
    "path": "/",
    "recursive": true
  }
}
```

## Troubleshooting

### Workspace Service Not Running

```bash
# Check pod status
kubectl get pods -n openclaw-personal

# Check workspace service logs
kubectl logs -n openclaw-personal -l app=openclaw -c workspace-service

# Check events
kubectl get events -n openclaw-personal --sort-by='.lastTimestamp'
```

### MosBot API Can't Connect

```bash
# Test DNS resolution
kubectl run -it --rm debug --image=busybox --restart=Never -- \
  nslookup openclaw-workspace.agents.svc.cluster.local

# Test HTTP connectivity
kubectl run -it --rm debug --image=curlimages/curl --restart=Never -- \
  curl -v http://openclaw-workspace.agents.svc.cluster.local:8080/health

# Check MosBot API logs
kubectl logs -n mosbot -l app=mosbot-api --tail=50
```

### Authentication Errors

```bash
# Verify secrets exist
kubectl get secret openclaw-secrets -n agents -o yaml
kubectl get secret mosbot-api-secrets -n mosbot -o yaml

# Check if tokens match
kubectl get secret openclaw-secrets -n agents -o jsonpath='{.data.WORKSPACE_SERVICE_TOKEN}' | base64 -d
kubectl get secret mosbot-api-secrets -n mosbot -o jsonpath='{.data.OPENCLAW_WORKSPACE_TOKEN}' | base64 -d
```

### Permission Denied

```bash
# Check PVC permissions
kubectl exec -n openclaw-personal -l app=openclaw -c workspace-service -- ls -la /workspace

# Verify fsGroup
kubectl get pod -n openclaw-personal -l app=openclaw -o yaml | grep fsGroup
```

## Next Steps

1. **Integrate with MosBot Dashboard** - Add UI for browsing workspace files
2. **Add Activity Logging** - Track file changes in MosBot activity log
3. **Enable Webhooks** - Real-time notifications for file changes
4. **Add Version Control** - Track file history and enable rollback

## Full Documentation

- [OpenClaw Workspace Integration Guide](./openclaw-workspace-integration.md)
- [Workspace Service README](../../homelab-gitops/apps/homelab/openclaw/workspace-service/README.md)
- [OpenClaw Public API](./openclaw-public-api.md)

## Support

If you encounter issues:

1. Check the troubleshooting section above
2. Review logs from both services
3. Verify network connectivity and DNS
4. Ensure secrets are configured correctly
