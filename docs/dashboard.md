# MosBot Dashboard — Documentation

The dashboard docs live in the [mosbot-dashboard repository](https://github.com/bymosbot/mosbot-dashboard) alongside the code they describe.

> **Note:** A dedicated `mosbot-docs` repo is planned. When it exists, all docs will be consolidated there and this page will redirect.

---

## Index

### MosBot OS

- `mosbot-os/overview.md` — MosBot OS mental model and dashboard navigation map

### Getting started

- `getting-started/local-development.md` — run the dashboard locally
- `getting-started/configuration.md` — `VITE_*` environment variables and runtime config

### Features

- `features/kanban.md` — Kanban board and task status pipeline
- `features/task-modal.md` — Task detail modal, lazy-loaded tabs, deep links
- `features/task-manager.md` — Runtime operations view, session KPIs, cron jobs
- `features/org-chart.md` — Multi-agent system map and live status overlays
- `features/workspaces.md` — Browsable artifact layer and file operations
- `features/docs.md` — Docs workspace (`/workspace/docs`)
- `features/activity-log.md` — Chronological activity narrative
- `features/archived.md` — Archived tasks and restore flow
- `features/settings-users.md` — User list and role management UI

### Security

- `security/permissions.md` — Roles and permissions matrix (dashboard UX)
- `security/secrets.md` — `VITE_*` build-time secrets and GitHub Actions

### Integrations

- `integrations/mosbot-api.md` — How the dashboard talks to MosBot API
- `integrations/openclaw.md` — OpenClaw health/status semantics and degradation

### Operations / deployment

- `operations/cloudflare-access.md` — Cloudflare Access configuration runbook
- `deployment/static-hosting.md` — S3/CloudFront deployment (CI + manual)

### Reference

- `reference/workspaces-quick-reference.md` — Common workspace operations and errors
