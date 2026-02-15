# Agent Auto-Discovery

The Mosbot dashboard now automatically discovers agents from the OpenClaw configuration instead of requiring hardcoded agent definitions in the frontend code.

## How It Works

### API Endpoint

**`GET /api/v1/openclaw/agents`**

Returns a list of configured agents from the OpenClaw `openclaw.json` configuration file.

**Response Example:**
```json
{
  "data": [
    {
      "id": "coo",
      "name": "COO",
      "label": "Chief Operating Officer",
      "description": "operations director",
      "icon": "📊",
      "workspace": "/home/node/.openclaw/workspace-coo",
      "isDefault": true
    },
    {
      "id": "cto",
      "name": "CTO",
      "label": "Chief Technology Officer",
      "description": "tech architect",
      "icon": "💼",
      "workspace": "/home/node/.openclaw/workspace-cto",
      "isDefault": false
    }
  ]
}
```

### Configuration

The API reads agents from the OpenClaw config file specified by `OPENCLAW_CONFIG_PATH` environment variable (defaults to `/home/node/.openclaw/openclaw.json`).

**OpenClaw Config Structure:**
```json
{
  "agents": {
    "list": [
      {
        "id": "coo",
        "workspace": "/home/node/.openclaw/workspace-coo",
        "identity": {
          "name": "COO",
          "theme": "operations director",
          "emoji": "📊"
        },
        "default": true
      }
    ]
  }
}
```

### Dashboard Integration

The dashboard uses the `agentStore` (Zustand) to:
1. Fetch agents on app initialization
2. Cache agents for the session
3. Dynamically populate the agent selector
4. Route to agent-specific workspaces

**Components using auto-discovery:**
- `src/pages/Workspace.jsx` - Main workspace page
- `src/components/WorkspaceExplorer.jsx` - File browser with agent selector
- `src/components/Sidebar.jsx` - Navigation links
- `src/App.jsx` - Route defaults

### Fallback Behavior

If the API cannot read the OpenClaw config file:
- **API**: Returns a default COO agent
- **Dashboard**: Uses fallback agents from `src/config/agentWorkspaces.js`

This ensures the dashboard works even if:
- The config file is not mounted
- OpenClaw is not configured yet
- The config file is malformed

## Adding New Agents

### In Production (Kubernetes)

1. Edit the OpenClaw config in GitOps:
   ```yaml
   # homelab-gitops/apps/homelab/openclaw/overlays/personal/configmap.yaml
   agents:
     list:
       - id: "new-agent"
         workspace: "/home/node/.openclaw/workspace-new-agent"
         identity:
           name: "New Agent"
           theme: "agent theme"
           emoji: "🎯"
   ```

2. Commit and push - Argo CD will sync the changes

3. The dashboard will automatically discover the new agent on next page load (no code changes needed!)

### Local Development

If running locally without access to the OpenClaw config:
1. Agents will fall back to the defaults in `src/config/agentWorkspaces.js`
2. Optionally, set `OPENCLAW_CONFIG_PATH` to point to a local config file

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_CONFIG_PATH` | `/home/node/.openclaw/openclaw.json` | Path to OpenClaw config file for agent discovery |
| `OPENCLAW_WORKSPACE_URL` | - | URL of OpenClaw workspace service (required) |

## Benefits

✅ **No code changes needed** - Add agents in OpenClaw config only
✅ **Single source of truth** - Agents defined once in OpenClaw
✅ **Automatic sync** - Dashboard reflects current OpenClaw agent configuration
✅ **Graceful fallback** - Works even if config is unavailable
✅ **Type-safe** - Full TypeScript support maintained

## Troubleshooting

### Agents not appearing in dashboard

1. Check API endpoint returns agents:
   ```bash
   curl -H "Authorization: Bearer $TOKEN" https://mosbot.bymos.dev/api/v1/openclaw/agents
   ```

2. Check OpenClaw config file exists:
   ```bash
   kubectl exec -n openclaw-personal deployment/openclaw -- cat /home/node/.openclaw/openclaw.json
   ```

3. Check Mosbot API logs:
   ```bash
   kubectl logs -n mosbot deployment/mosbot-api | grep "agents"
   ```

### Using custom config path

Set the environment variable in Kubernetes:
```yaml
# In mosbot deployment
env:
  - name: OPENCLAW_CONFIG_PATH
    value: "/path/to/custom/openclaw.json"
```
