# OpenClaw Workspace Integration - Architecture Diagram

## System Overview

```bash
┌──────────────────────────────────────────────────────────────────────────┐
│                              Internet                                     │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │
                                 │ HTTPS
                                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         Cloudflare Tunnel                                 │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │
                                 │ HTTP
                                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                      Kubernetes Cluster (Homelab)                         │
│                                                                            │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                      Namespace: mosbot                              │  │
│  │                                                                      │  │
│  │  ┌──────────────────────────────────────────────────────────────┐  │  │
│  │  │              MosBot Dashboard (React SPA)                     │  │  │
│  │  │                                                                │  │  │
│  │  │  Components:                                                   │  │  │
│  │  │  - Task Kanban Board                                          │  │  │
│  │  │  - Activity Log                                               │  │  │
│  │  │  - User Management                                            │  │  │
│  │  │  - [Future] Workspace File Browser ⭐                        │  │  │
│  │  └──────────────────┬───────────────────────────────────────────┘  │  │
│  │                     │ HTTP API Calls                                │  │
│  │                     │ (JWT Auth)                                    │  │
│  │                     ▼                                                │  │
│  │  ┌──────────────────────────────────────────────────────────────┐  │  │
│  │  │              MosBot API (Node.js/Express)                     │  │  │
│  │  │                                                                │  │  │
│  │  │  Routes:                                                       │  │  │
│  │  │  - /api/v1/tasks          (Task CRUD)                        │  │  │
│  │  │  - /api/v1/users          (User management)                  │  │  │
│  │  │  - /api/v1/activity       (Activity logs)                    │  │  │
│  │  │  - /api/v1/auth           (JWT auth)                         │  │  │
│  │  │  - /api/v1/openclaw/workspace/* ⭐ NEW                       │  │  │
│  │  │                                                                │  │  │
│  │  │  Database: PostgreSQL                                         │  │  │
│  │  └──────────────────┬───────────────────────────────────────────┘  │  │
│  └─────────────────────┼──────────────────────────────────────────────┘  │
│                        │                                                  │
│                        │ HTTP (ClusterIP)                                │
│                        │ openclaw-workspace.agents.svc.cluster.local:8080│
│                        │                                                  │
│  ┌─────────────────────┼──────────────────────────────────────────────┐  │
│  │                     │         Namespace: agents                     │  │
│  │                     ▼                                                │  │
│  │  ┌──────────────────────────────────────────────────────────────┐  │  │
│  │  │                   OpenClaw Pod                                │  │  │
│  │  │                                                                │  │  │
│  │  │  ┌────────────────────────────────────────────────────────┐  │  │  │
│  │  │  │         Container: openclaw (Main Agent)               │  │  │  │
│  │  │  │                                                          │  │  │  │
│  │  │  │  - Claude Sonnet AI Agent                              │  │  │  │
│  │  │  │  - Code execution & file operations                    │  │  │  │
│  │  │  │  - Workspace: /home/node/.openclaw (RW)               │  │  │  │
│  │  │  │  - Resources: 50m-2000m CPU, 128Mi-2Gi RAM            │  │  │  │
│  │  │  └────────────────┬───────────────────────────────────────┘  │  │  │
│  │  │                   │                                            │  │  │
│  │  │                   │ Shared PVC Mount                           │  │  │
│  │  │                   │                                            │  │  │
│  │  │  ┌────────────────┴───────────────────────────────────────┐  │  │  │
│  │  │  │      Container: workspace-service (Sidecar) ⭐ NEW     │  │  │  │
│  │  │  │                                                          │  │  │  │
│  │  │  │  - Lightweight Node.js HTTP server                     │  │  │  │
│  │  │  │  - Exposes workspace files via REST API                │  │  │  │
│  │  │  │  - Workspace: /workspace (RO)                          │  │  │  │
│  │  │  │  - Resources: 10m-100m CPU, 32Mi-128Mi RAM            │  │  │  │
│  │  │  │  - Port: 8080 (ClusterIP only)                        │  │  │  │
│  │  │  │                                                          │  │  │  │
│  │  │  │  Endpoints:                                             │  │  │  │
│  │  │  │  - GET  /files                                         │  │  │  │
│  │  │  │  - GET  /files/content                                 │  │  │  │
│  │  │  │  - POST /files                                         │  │  │  │
│  │  │  │  - PUT  /files                                         │  │  │  │
│  │  │  │  - DELETE /files                                       │  │  │  │
│  │  │  │  - GET  /status                                        │  │  │  │
│  │  │  │  - GET  /health                                        │  │  │  │
│  │  │  └────────────────┬───────────────────────────────────────┘  │  │  │
│  │  │                   │                                            │  │  │
│  │  │                   │ Volume Mount                               │  │  │
│  │  │                   ▼                                            │  │  │
│  │  │  ┌──────────────────────────────────────────────────────────┐  │  │
│  │  │  │         PVC: openclaw-state (Longhorn)                   │  │  │
│  │  │  │                                                            │  │  │
│  │  │  │  Storage: 10Gi                                            │  │  │
│  │  │  │  Access Mode: ReadWriteOnce                              │  │  │
│  │  │  │  Storage Class: longhorn                                 │  │  │
│  │  │  │                                                            │  │  │
│  │  │  │  Contents:                                                │  │  │
│  │  │  │  - /config.json (OpenClaw config)                        │  │  │
│  │  │  │  - /workspaces/ (Agent workspaces)                       │  │  │
│  │  │  │  - /logs/ (Agent logs)                                   │  │  │
│  │  │  │  - /cache/ (Temp files)                                  │  │  │
│  │  │  └──────────────────────────────────────────────────────────┘  │  │
│  │  └──────────────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
└──────────────────────────────────────────────────────────────────────────┘
```

## Data Flow: Reading a Workspace File

```bash
┌──────────────┐
│   User       │
│  (Browser)   │
└──────┬───────┘
       │
       │ 1. Click "View file" in dashboard
       ▼
┌──────────────────────────────────────────────────────────────┐
│  MosBot Dashboard                                             │
│                                                                │
│  JavaScript:                                                  │
│  fetch('/api/v1/openclaw/workspace/files/content?path=/...')│
│  .then(res => res.json())                                    │
└──────┬───────────────────────────────────────────────────────┘
       │
       │ 2. HTTP GET with JWT token
       │    Authorization: Bearer <jwt>
       ▼
┌──────────────────────────────────────────────────────────────┐
│  MosBot API                                                   │
│                                                                │
│  src/routes/openclaw.js:                                     │
│  1. Verify JWT token                                         │
│  2. Extract user from token                                  │
│  3. Log request (user, path)                                 │
│  4. Forward to workspace service                             │
└──────┬───────────────────────────────────────────────────────┘
       │
       │ 3. HTTP GET to workspace service
       │    http://openclaw-workspace.agents:8080/files/content
       │    Authorization: Bearer <service-token>
       ▼
┌──────────────────────────────────────────────────────────────┐
│  Workspace Service (Sidecar)                                 │
│                                                                │
│  server.js:                                                   │
│  1. Verify service token (optional)                          │
│  2. Validate path (prevent traversal)                        │
│  3. Resolve path: /workspace + requested_path                │
│  4. Read file from filesystem                                │
│  5. Return file content + metadata                           │
└──────┬───────────────────────────────────────────────────────┘
       │
       │ 4. Read from PVC
       ▼
┌──────────────────────────────────────────────────────────────┐
│  Longhorn PVC (openclaw-state)                               │
│                                                                │
│  Mounted at: /workspace (read-only)                          │
│  File: /workspace/path/to/file.md                            │
└──────┬───────────────────────────────────────────────────────┘
       │
       │ 5. File content returned
       ▼
┌──────────────────────────────────────────────────────────────┐
│  Workspace Service                                            │
│                                                                │
│  Response:                                                    │
│  {                                                            │
│    "path": "/path/to/file.md",                              │
│    "name": "file.md",                                        │
│    "type": "file",                                           │
│    "size": 1234,                                             │
│    "content": "# File content...",                          │
│    "encoding": "utf8"                                        │
│  }                                                            │
└──────┬───────────────────────────────────────────────────────┘
       │
       │ 6. JSON response
       ▼
┌──────────────────────────────────────────────────────────────┐
│  MosBot API                                                   │
│                                                                │
│  Response:                                                    │
│  { "data": { ... } }                                         │
└──────┬───────────────────────────────────────────────────────┘
       │
       │ 7. JSON response
       ▼
┌──────────────────────────────────────────────────────────────┐
│  MosBot Dashboard                                             │
│                                                                │
│  Display file content in editor/viewer                       │
└──────────────────────────────────────────────────────────────┘
```

## Security Layers

```bash
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: Network Isolation                                  │
│  - Workspace service: ClusterIP only (no external access)   │
│  - MosBot API: Ingress with Cloudflare protection          │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: Authentication                                     │
│  - User → MosBot API: JWT token (existing system)          │
│  - MosBot API → Workspace Service: Bearer token (optional)  │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: Authorization                                      │
│  - JWT contains user ID and role                            │
│  - Can add per-file permissions later                       │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 4: Path Validation                                    │
│  - Normalize paths                                           │
│  - Block ".." sequences                                      │
│  - Ensure paths stay within /workspace                      │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 5: Filesystem Permissions                             │
│  - Workspace service runs as user 1000:1000                 │
│  - PVC mounted with fsGroup: 1000                           │
│  - Optional: read-only mount for extra safety               │
└─────────────────────────────────────────────────────────────┘
```

## Resource Allocation

```bash
┌──────────────────────────────────────────────────────────────┐
│  OpenClaw Pod Total Resources                                 │
│                                                                │
│  Requests: 60m CPU, 160Mi RAM                                │
│  Limits: 2100m CPU, 2.1Gi RAM                                │
│                                                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  OpenClaw Agent (Main Container)                       │  │
│  │                                                          │  │
│  │  Requests: 50m CPU, 128Mi RAM                          │  │
│  │  Limits: 2000m CPU, 2Gi RAM                            │  │
│  │                                                          │  │
│  │  QoS: Burstable (low request, high limit)             │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Workspace Service (Sidecar) ⭐                        │  │
│  │                                                          │  │
│  │  Requests: 10m CPU, 32Mi RAM                           │  │
│  │  Limits: 100m CPU, 128Mi RAM                           │  │
│  │                                                          │  │
│  │  QoS: Burstable (minimal overhead)                     │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## Deployment Topology

```bash
┌──────────────────────────────────────────────────────────────┐
│  Kubernetes Node: k8s-wkr-amd64-03                           │
│                                                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  OpenClaw Pod (pinned to this node)                    │  │
│  │                                                          │  │
│  │  Reason: RWO PVC requires pod on same node as volume   │  │
│  │  Benefit: Fast restarts, no volume migration           │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Longhorn Volume (local replica)                       │  │
│  │                                                          │  │
│  │  - Primary replica on this node                        │  │
│  │  - Backup replicas on other nodes                      │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  Other Kubernetes Nodes                                       │
│                                                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  MosBot API Pods (can run anywhere)                    │  │
│  │                                                          │  │
│  │  - Replicas: 2                                         │  │
│  │  - Strategy: RollingUpdate                             │  │
│  │  - Can scale horizontally                              │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## Future Architecture: With Webhooks

```bash
┌──────────────────────────────────────────────────────────────┐
│  OpenClaw Pod                                                 │
│                                                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Workspace Service (Enhanced)                          │  │
│  │                                                          │  │
│  │  New Features:                                          │  │
│  │  - Filesystem watcher (chokidar)                       │  │
│  │  - Webhook sender                                       │  │
│  │  - Event queue                                          │  │
│  │                                                          │  │
│  │  On file change:                                        │  │
│  │  1. Detect change (create/update/delete)               │  │
│  │  2. Queue webhook event                                 │  │
│  │  3. POST to MosBot API                                  │  │
│  └────────────┬───────────────────────────────────────────┘  │
└───────────────┼──────────────────────────────────────────────┘
                │
                │ Webhook: POST /api/v1/openclaw/webhooks/file-changed
                │ { "event": "updated", "path": "/file.md", ... }
                ▼
┌──────────────────────────────────────────────────────────────┐
│  MosBot API                                                   │
│                                                                │
│  New Webhook Handler:                                        │
│  1. Verify webhook signature                                 │
│  2. Log activity (file changed)                             │
│  3. Notify connected clients (WebSocket)                    │
│  4. Update cache/index                                       │
└──────────────┬───────────────────────────────────────────────┘
               │
               │ WebSocket push
               ▼
┌──────────────────────────────────────────────────────────────┐
│  MosBot Dashboard                                             │
│                                                                │
│  Real-time Updates:                                          │
│  - Show notification: "file.md updated"                     │
│  - Refresh file browser                                      │
│  - Update activity feed                                      │
└──────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### MosBot Dashboard (React SPA)

- **Purpose**: User interface
- **Responsibilities**:
  - Display tasks, users, activity
  - [Future] Browse workspace files
  - [Future] Edit markdown files
  - Handle user authentication
- **Technology**: React, Zustand, Tailwind CSS

### MosBot API (Node.js/Express)

- **Purpose**: API gateway and business logic
- **Responsibilities**:
  - Task management (CRUD)
  - User management
  - Activity logging
  - JWT authentication
  - Proxy to workspace service
  - [Future] Webhook receiver
- **Technology**: Express, PostgreSQL, JWT

### Workspace Service (Node.js/Express)

- **Purpose**: File access abstraction
- **Responsibilities**:
  - Expose workspace files via HTTP
  - Path validation and security
  - File operations (list, read, write, delete)
  - [Future] Filesystem watching
  - [Future] Webhook sending
- **Technology**: Express, Node.js fs module

### OpenClaw Agent (Claude Sonnet)

- **Purpose**: AI coding assistant
- **Responsibilities**:
  - Execute coding tasks
  - Manage workspace files
  - Interact with tools and APIs
  - Generate code and documentation
- **Technology**: Claude Sonnet, OpenClaw Gateway

### Longhorn PVC

- **Purpose**: Persistent storage
- **Responsibilities**:
  - Store workspace files
  - Provide durability (replicas)
  - Enable backups and snapshots
- **Technology**: Longhorn distributed storage
