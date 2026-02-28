# MosBot OS (overview)

MosBot OS is a **self-hosted operating system for agent work**.

This repo (`mosbot-api`) is the **API / backend layer** within that larger system.

## The layered model

```text
MosBot Dashboard (UI layer)  ->  MosBot API (backend)  ->  OpenClaw (runtime + source of truth)
```

- **MosBot Dashboard**: the UI for humans to manage tasks, see activity, browse workspaces, and operate the system.
- **MosBot API**: the task backend + integration layer (REST endpoints for tasks/users/activity + OpenClaw workspace integration).
- **OpenClaw**: agent runtime + configuration (agents/workspaces/config). In the ecosystem’s mental model, OpenClaw is the “source of truth” for agent/workspace structure.

## What MosBot is about (brief)

- **Tasks as the durable unit of work**: operational work, product work, and agent work should map cleanly to tasks.
- **Visibility and auditability**: activity logs + task history provide an operational narrative of what happened.
- **Self-hosted by default**: you control infrastructure, data, and access.
- **Agent-friendly interfaces**: integrate agent runtimes (OpenClaw) with a human-operable UI.

## Related

- Docs index: `docs/README.md`
- Public API contract (OpenClaw integration): `docs/api/openclaw-public-api.md`
- OpenClaw workspace integration: `docs/openclaw/workspace/`

Note: the dashboard repo also contains MosBot OS framing and copy; keep cross-repo wording consistent.
