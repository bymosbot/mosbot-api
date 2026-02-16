# OpenClaw workspace integration: operations and troubleshooting

## Common checks

### Workspace service is reachable (from Mosbot API runtime)

If running locally with port-forward, start with:

```bash
curl -v http://localhost:8080/health
```

### Mosbot workspace status

```bash
curl -H "Authorization: Bearer <MOSBOT_JWT>" \
  "http://localhost:3000/api/v1/openclaw/workspace/status"
```

## Typical failure modes

- **503 from Mosbot API workspace endpoints**
  - Mosbot is not configured with `OPENCLAW_WORKSPACE_URL`, or the service is down
- **401/403**
  - Missing/invalid Mosbot JWT or insufficient role for content/mutation routes
- **404 file not found**
  - Wrong path (remember workspace paths are rooted at `/`)

## Kubernetes debugging snippets

```bash
# Check pods
kubectl get pods -n openclaw-personal

# Sidecar logs (container name may vary)
kubectl logs -n openclaw-personal -l app=openclaw -c workspace-service --tail=50
```

## Related

- Quickstart: `docs/openclaw/workspace/quickstart.md`
- Local dev: `docs/guides/openclaw-local-development.md`
