# Docker (development)

This repo includes a `docker-compose.yml` for local development.

## Start

```bash
docker-compose up -d
```

API will be available at:

- `http://localhost:3000`

Health check:

```bash
curl http://localhost:3000/health
```

## OpenClaw networking note

If you run Mosbot API inside Docker but port-forward OpenClaw services on your host, use:

- `http://host.docker.internal:<port>`

`docker-compose.yml` already includes:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

## Related

- Local dev (non-Docker): `docs/guides/local-development.md`
- OpenClaw local dev: `docs/guides/openclaw-local-development.md`
