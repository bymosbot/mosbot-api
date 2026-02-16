# Heartbeat Update Fix

## Issue

When trying to update the model selection for heartbeat jobs, the API returned "Invalid OpenClaw config structure" error.

## Root Cause

The OpenClaw config structure has changed from:

```json
{
  "agents": [
    { "id": "coo", "heartbeat": { ... } }
  ]
}
```

To:

```json
{
  "agents": {
    "list": [
      { "id": "coo", "heartbeat": { ... } }
    ]
  }
}
```

The `updateHeartbeatConfig()` function was checking for `config.agents` as an array, but it's actually `config.agents.list`.

## Fix Applied

### File: `src/services/cronJobsService.js`

Updated the `updateHeartbeatConfig()` function to handle both formats:

```javascript
// Find the agent in config - handle both agents.list and agents array formats
let agentsList = null;
if (config.agents && Array.isArray(config.agents.list)) {
  // New format: { agents: { list: [...] } }
  agentsList = config.agents.list;
} else if (config.agents && Array.isArray(config.agents)) {
  // Old format: { agents: [...] }
  agentsList = config.agents;
} else {
  const err = new Error('Invalid OpenClaw config structure: agents.list or agents array not found');
  err.status = 500;
  err.code = 'INVALID_CONFIG';
  throw err;
}

const agentIndex = agentsList.findIndex(a => a.id === agentId);
```

### File: `src/routes/openclaw.js`

Also enhanced the GET endpoint to include all heartbeat fields in the payload:

```javascript
payload: {
  kind: 'heartbeat',
  model: hb.model || null,
  session: hb.session || 'main',
  target: hb.target || 'last',
  prompt: hb.prompt || null,
  ackMaxChars: hb.ackMaxChars || 200,
}
```

This ensures that when editing a heartbeat job, all fields are properly populated in the form.

## Testing

To test the fix:

1. Navigate to the Scheduler page
2. Click Edit on any heartbeat job (e.g., "MosBot Heartbeat")
3. Change the model selection
4. Click "Update"
5. Verify the update succeeds without "Invalid OpenClaw config structure" error
6. Verify the model change is reflected in the OpenClaw config

## Backward Compatibility

The fix maintains backward compatibility by checking for both formats:
- New format: `config.agents.list` (current OpenClaw structure)
- Old format: `config.agents` (legacy structure)

This ensures the code works with both old and new OpenClaw configurations.
