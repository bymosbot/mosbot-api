# Deployment

## Docker (recommended)

### Full stack (API + Dashboard + Postgres)

Clone both repos side-by-side, then:

```bash
cd mosbot-api
cp .env.example .env   # edit required values
make up
```

### API only

```bash
docker build --target production -t mosbot-api:latest .
docker run -p 3000:3000 --env-file .env mosbot-api:latest
```

### Pre-built images (GHCR)

```bash
docker pull ghcr.io/bymosbot/mosbot-api:latest
docker run -p 3000:3000 --env-file .env ghcr.io/bymosbot/mosbot-api:latest
```

Available tags:

| Tag | Description |
| --- | ----------- |
| `latest` | Latest build from `main` |
| `main` | Latest build from `main` |
| `sha-<short>` | Specific commit |
| `v1.2.3` | Specific release |

## Kubernetes

See [docs/guides/kubernetes-deployment.md](guides/kubernetes-deployment.md).

A `k8s/` directory with base manifests and a secret template is included. Copy `k8s/base/secret.template.yaml` to `k8s/base/secret.yaml` (gitignored), fill in base64-encoded values, and apply with `kubectl apply -k k8s/base/`.

## Environment variables

See [docs/configuration.md](configuration.md) for the full reference.

## Database migrations

Migrations run automatically on startup. To run manually:

```bash
npm run migrate
# or
make migrate
```

See [docs/guides/database-migrations.md](guides/database-migrations.md).

## Health check

```bash
curl http://localhost:3000/health
# → {"status":"ok","timestamp":"..."}
```

## Production checklist

- [ ] `JWT_SECRET` is a long random string (≥ 48 hex chars)
- [ ] `DB_PASSWORD` is strong and unique
- [ ] `CORS_ORIGIN` is set to the exact dashboard URL
- [ ] `NODE_ENV=production`
- [ ] `BOOTSTRAP_OWNER_PASSWORD` is unset after first login
- [ ] Running behind a reverse proxy with TLS
- [ ] Database is not publicly accessible
- [ ] Regular backups configured
