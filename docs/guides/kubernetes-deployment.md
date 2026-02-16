# Kubernetes deployment

This repo contains Kubernetes manifests under `k8s/` (Kustomize layout).

## Structure

- `k8s/base/` — base manifests
- `k8s/overlays/` — environment overlays

## Secrets

Start from the template:

```bash
cp k8s/base/secret.template.yaml k8s/base/secret.yaml
```

Fill in the required values (base64-encoded as needed), then apply your chosen overlay/base.

## Apply (example)

```bash
kubectl apply -k k8s/base
```

## Related

- Docker dev: `docs/guides/docker.md`
- OpenClaw workspace docs: `docs/openclaw/workspace/`
