# First-run setup

This guide walks you through setting up MosBot OS for the first time.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose v2
- Both repos cloned side-by-side:

  ```text
  parent-folder/
  ├── mosbot-api/
  └── mosbot-dashboard/
  ```

## Step 1: Configure environment

```bash
cd mosbot-api
cp .env.example .env
```

Open `.env` and set these required values:

```bash
# Strong password for PostgreSQL
DB_PASSWORD=choose-a-strong-password

# Generate with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
JWT_SECRET=your-long-random-secret

# Your first owner account (created automatically on first start)
BOOTSTRAP_OWNER_EMAIL=admin@example.com
BOOTSTRAP_OWNER_PASSWORD=choose-another-strong-password-min-12-chars
```

## Step 2: Start the stack

```bash
make up
# or: docker compose up -d
```

This starts Postgres, the API, and the dashboard. The dashboard runs as a **Vite dev server with hot-reload** — source changes in `mosbot-dashboard/` reflect instantly in the browser without a rebuild.

Wait for all services to be healthy (usually 15–30 seconds):

```bash
docker compose ps
```

> **Production build:** if you want the optimised nginx bundle instead (e.g. for a staging environment), run `make up-prod` which builds the dashboard image before starting.

## Step 3: Verify

```bash
curl http://localhost:3000/health
# → {"status":"ok","timestamp":"..."}
```

Open **<http://localhost:5173>** and log in with the email and password you set in `BOOTSTRAP_OWNER_EMAIL` / `BOOTSTRAP_OWNER_PASSWORD`.

## Step 4: Secure your setup

After the first successful login:

1. **Remove `BOOTSTRAP_OWNER_PASSWORD` from `.env`** (or set it to an empty string).
2. Change your password in the dashboard under Settings → Users.
3. Restart the API to confirm it starts without the bootstrap vars.

## Step 5: Configure OpenClaw (optional)

If you have an OpenClaw instance, add the integration variables to `.env`:

```bash
OPENCLAW_WORKSPACE_URL=http://localhost:8080
OPENCLAW_WORKSPACE_TOKEN=your-workspace-token
OPENCLAW_GATEWAY_URL=http://localhost:18789
OPENCLAW_GATEWAY_TOKEN=your-gateway-token
```

Then restart: `docker compose restart api`

See [docs/openclaw/README.md](../openclaw/README.md) for details.

## Troubleshooting

**API fails to start with "JWT_SECRET environment variable is not set"**
→ Set `JWT_SECRET` in `.env` and restart.

**API fails to start with "CORS_ORIGIN cannot be '*'"**
→ Set `CORS_ORIGIN` to the exact dashboard URL (e.g. `http://localhost:5173`).

**Dashboard shows "Failed to connect to API"**
→ Verify `VITE_API_URL` in `mosbot-dashboard/.env` matches the running API URL.

**No owner account created**
→ Check API logs: `docker compose logs api`. Ensure `BOOTSTRAP_OWNER_EMAIL` and `BOOTSTRAP_OWNER_PASSWORD` are set before the first start.
