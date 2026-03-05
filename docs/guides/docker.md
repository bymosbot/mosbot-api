# Docker

## Full-stack test harness

The `docker/` directory contains a self-contained test harness that runs the entire MosBot + OpenClaw stack locally. This is the recommended way to test the full integration.

### Prerequisites

Clone all three repos side-by-side:

```text
parent-folder/
├── mosbot-api/
├── mosbot-dashboard/
└── mosbot-workspace-service/
```

Docker and Docker Compose v2 are required.

### First-time setup

```bash
cd mosbot-api/docker
make setup
```

This runs `docker-setup.sh` which:

- Pulls the OpenClaw Docker image
- Creates the `openclaw-config/` directory structure
- Generates secrets (JWT, workspace token, bootstrap password)
- Writes everything to `docker/.env`
- Runs OpenClaw onboarding (interactive)

### Start the stack

```bash
make up
```

Services started:

| Service   | URL                      | Description                  |
| --------- | ------------------------ | ---------------------------- |
| API       | http://localhost:3000     | MosBot API                   |
| Dashboard | http://localhost:5173     | Vite dev server (hot-reload) |
| OpenClaw  | http://localhost:18789    | OpenClaw Gateway             |
| Workspace | http://localhost:18780    | Workspace Service            |
| PostgreSQL| localhost:5432            | Database                     |

### Other commands

```bash
make logs     # Follow all service logs
make ps       # Show container status
make down     # Stop all containers
make reset    # Nuke everything: containers, volumes, DB, OpenClaw config
```

After `make reset`, run `make setup` again to start fresh.

## Root docker-compose.yml (API + Dashboard + Postgres only)

The root `docker-compose.yml` runs a 3-service stack without OpenClaw. This is useful when you only need the API and dashboard, or when connecting to an external OpenClaw instance.

```bash
cd mosbot-api
docker compose up -d
```

See `docs/getting-started/first-run.md` for initial `.env` setup.

### Production builds

For a production-like local build using pre-built images from GHCR:

```bash
docker pull ghcr.io/bymosbot/mosbot-api:latest
docker run -p 3000:3000 --env-file .env ghcr.io/bymosbot/mosbot-api:latest
```

## Related

- Local dev (non-Docker): `docs/guides/local-development.md`
- OpenClaw local dev: `docs/guides/openclaw-local-development.md`
