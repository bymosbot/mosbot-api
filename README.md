# MosBot API

This repository is the **API / backend layer** of the larger **MosBot OS**.

MosBot OS is a **self-hosted operating system for agent work**: the dashboard provides the UI, this API provides the task + integration surface, and OpenClaw is the runtime/source-of-truth for agents and workspaces.

See `docs/mosbot-os.md` for a short overview.

## Quick start (local, recommended: Docker)

```bash
docker-compose up -d
```

Health check:

```bash
curl http://localhost:3000/health
```

## Quick start (local, run natively)

See `docs/guides/local-development.md` for full instructions.

```bash
npm install
cp .env.example .env
npm run migrate
npm run dev
```

## Documentation

Start here:

- `docs/README.md`

Key docs:

- Local dev: `docs/guides/local-development.md`
- Docker dev: `docs/guides/docker.md`
- Kubernetes deployment: `docs/guides/kubernetes-deployment.md`
- Database migrations: `docs/guides/database-migrations.md`
- OpenClaw local dev: `docs/guides/openclaw-local-development.md`
- OpenClaw workspace integration: `docs/openclaw/workspace/`
- Public API contract (OpenClaw integration): `docs/api/openclaw-public-api.md`

## Contributing

See `CONTRIBUTING.md`.

## Agent entrypoint

See `AGENTS.md` for agent guidance.
