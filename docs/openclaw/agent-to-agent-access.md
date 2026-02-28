# OpenClaw Agent-to-Agent Access Configuration

## Overview

Agent-to-agent access controls whether one agent can view the session history of another agent through the OpenClaw Gateway. This feature is required for the MosBot Dashboard to display message history for agent sessions.

## Why This is Needed

The MosBot Dashboard shows sessions from all agents in your organization. When you click on an agent session (e.g., `agent:cmo:main`), the dashboard needs to fetch the full message history from OpenClaw Gateway.

Without agent-to-agent access enabled, OpenClaw returns:

```json
{
  "status": "forbidden",
  "error": "Agent-to-agent history is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent access."
}
```

This results in sessions showing usage statistics but no messages.

## How to Enable

### Option 1: Environment Variable (Recommended for Kubernetes)

Set the environment variable in your OpenClaw Gateway deployment:

```bash
OPENCLAW_TOOLS_AGENT_TO_AGENT_ENABLED=true
```

**For Kubernetes deployments:**

```yaml
# apps/agents/openclaw/overlays/production/deployment-patch.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: openclaw
spec:
  template:
    spec:
      containers:
      - name: openclaw
        env:
        - name: OPENCLAW_TOOLS_AGENT_TO_AGENT_ENABLED
          value: "true"
```

### Option 2: Configuration File

If OpenClaw Gateway uses a configuration file (e.g., `openclaw.json`, `config.json`), add:

```json
{
  "tools": {
    "agentToAgent": {
      "enabled": true
    }
  }
}
```

### Option 3: Runtime Configuration

If OpenClaw supports runtime configuration updates, you may be able to enable this feature without restarting:

```bash
# Example using OpenClaw CLI (if available)
openclaw config set tools.agentToAgent.enabled true
```

## Verification

After enabling agent-to-agent access, verify it's working:

### 1. Check OpenClaw Gateway Logs

Look for configuration confirmation in the logs:

```bash
kubectl logs -n agents deployment/openclaw | grep -i "agent.*agent"
```

### 2. Test via API

```bash
curl -X POST http://openclaw.agents.svc.cluster.local:18789/tools/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -d '{
    "tool": "sessions_history",
    "action": "json",
    "args": {
      "sessionKey": "agent:cmo:main",
      "limit": 10
    },
    "sessionKey": "main"
  }'
```

Expected response should contain messages, not a "forbidden" error.

### 3. Test via Dashboard

1. Open the MosBot Dashboard
2. Navigate to an agent session (e.g., CMO, CTO)
3. Click to view session details
4. Messages should now be visible instead of "No messages in this session"

## Security Considerations

### What This Enables

Enabling agent-to-agent access allows:
- The main agent to view other agents' session histories
- Cross-agent session inspection for monitoring and debugging
- Dashboard to display full conversation history for all agents

### What This Does NOT Do

- Does not allow agents to modify each other's sessions
- Does not grant write access to other agents' data
- Does not expose agent credentials or sensitive configuration

### Best Practices

1. **Enable in trusted environments** - Only enable if all agents in your deployment are trusted
2. **Audit access** - Monitor OpenClaw Gateway logs for cross-agent access patterns
3. **Use RBAC** - Combine with MosBot API RBAC to control who can view agent sessions via the dashboard
4. **Consider alternatives** - If security is a concern, consider using separate OpenClaw instances per agent

## Troubleshooting

### Still Getting "Forbidden" Error

1. **Verify environment variable is set**:
   ```bash
   kubectl get deployment openclaw -n agents -o yaml | grep AGENT_TO_AGENT
   ```

2. **Check OpenClaw Gateway version**:
   - Ensure you're running a version that supports this feature
   - Check OpenClaw documentation for version-specific configuration

3. **Restart OpenClaw Gateway**:
   ```bash
   kubectl rollout restart deployment/openclaw -n agents
   ```

4. **Check logs for errors**:
   ```bash
   kubectl logs -n agents deployment/openclaw --tail=100
   ```

### Configuration Not Taking Effect

- Verify the configuration file path is correct
- Check file permissions (OpenClaw must be able to read it)
- Ensure no typos in configuration keys
- Restart OpenClaw Gateway after configuration changes

## Alternative: Per-Agent Access Control

If you need more granular control, you may be able to configure which agents can access which other agents:

```json
{
  "tools": {
    "agentToAgent": {
      "enabled": true,
      "allowList": ["main", "cmo", "cto"],
      "denyList": []
    }
  }
}
```

Check OpenClaw Gateway documentation for advanced access control options.

## Related Documentation

- [OpenClaw Gateway Configuration](https://github.com/openclaw/openclaw/docs/gateway-config.md)
- [MosBot API OpenClaw Integration](../integrations/openclaw.md)
- [Troubleshooting Empty Sessions](../troubleshooting/empty-sessions-with-usage.md)

## Support

If you continue to experience issues after following this guide:

1. Check OpenClaw Gateway logs for detailed error messages
2. Verify your OpenClaw version supports agent-to-agent access
3. Consult OpenClaw documentation for version-specific configuration
4. Contact OpenClaw support or open an issue in their repository
