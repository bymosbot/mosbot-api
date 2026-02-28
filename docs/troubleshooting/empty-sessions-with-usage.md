# Troubleshooting: Sessions with Usage Data but No Messages

## Problem Description

Some sessions in the MosBot Dashboard display usage statistics (input tokens, output tokens, cost) but show "No messages in this session" when opened.

Example:
```
Agent: CMO
Status: active
Usage: In: 14.2k • Out: 6 • Cost: $0.0006
Messages: (empty - shows "No messages in this session")
```

## Root Cause

This occurs due to a **data source mismatch** between two separate API calls:

### 1. Session List Endpoint (`GET /api/v1/openclaw/sessions`)

- Calls `sessionsList()` with `messageLimit: 1`
- Returns session metadata **plus the last message summary**
- Extracts usage data from `session.messages[0].usage`
- This is what populates the session list with token counts and costs

**Code location**: `src/routes/openclaw.js` lines 609-689

```javascript
// Session list includes last message for usage stats
const sessions = await sessionsList({
  sessionKey,
  limit: 500,
  messageLimit: 1  // ← Includes last message
});

// Extract usage from last message
const lastMessage = session.messages?.[0] || null;
const usage = lastMessage?.usage || {};
const inputTokens = (usage.input || 0) + (usage.cacheRead || 0);
const outputTokens = usage.output || 0;
const messageCost = usage.cost?.total || 0;
```

### 2. Session Messages Endpoint (`GET /api/v1/openclaw/sessions/:sessionId/messages`)

- Calls `sessionsHistory()` to retrieve **full message history**
- This is a **separate tool invocation** to OpenClaw Gateway
- If `sessionsHistory()` returns empty (for any reason), no messages are shown
- But the session metadata still shows usage stats from the session list

**Code location**: `src/routes/openclaw.js` lines 778-828

```javascript
// Separate call to get full message history
const historyResult = await sessionsHistory({
  sessionKey,
  limit: parseInt(limit, 10),
  includeTools: includeTools === 'true' || includeTools === true
});
```

## Why This Happens

The two data sources can be out of sync when:

1. **OpenClaw Gateway `sessions_history` tool fails** while `sessions_list` succeeds
   - Network timeout (10s timeout configured)
   - Tool not available or returns error
   - Graceful degradation returns empty array

2. **Different data persistence**
   - Session metadata might be cached/persisted separately from message history
   - OpenClaw may store session summaries differently than full message logs

3. **Race condition**
   - Session was updated between the two API calls
   - Messages were cleared/archived but session metadata persists

4. **Message filtering**
   - History endpoint filters out non-text messages (tool calls, thinking blocks)
   - If session only contains filtered messages, result is empty

5. **Session key mismatch**
   - Incorrect session key format passed to `sessionsHistory()`
   - Agent context not properly resolved

## Diagnostic Improvements Added

### Enhanced Logging in `src/routes/openclaw.js`

Added detailed logging before and after `sessionsHistory()` call:

```javascript
// Log raw result structure
logger.debug('sessionsHistory raw result', {
  sessionKey,
  resultType: Array.isArray(historyResult) ? 'array' : typeof historyResult,
  resultKeys: historyResult && typeof historyResult === 'object' ? Object.keys(historyResult) : null,
  isNull: historyResult === null,
  isUndefined: historyResult === undefined
});

// Log parsed message count
logger.info('Session history loaded', { 
  userId: req.user.id,
  sessionKey,
  messageCount: messages.length,
  rawMessageCount: Array.isArray(historyResult) ? historyResult.length : 
                   historyResult?.messages?.length || 
                   historyResult?.details?.messages?.length || 0
});
```

### Enhanced Logging in `src/services/openclawGatewayClient.js`

Added detailed logging in `sessionsHistory()` function:

```javascript
// Log tool result structure
logger.debug('sessions_history tool result', {
  sessionKey,
  resultType: Array.isArray(result) ? 'array' : typeof result,
  resultKeys: result && typeof result === 'object' ? Object.keys(result) : null,
  messagesCount: result?.messages?.length || (Array.isArray(result) ? result.length : 0),
  hasMessages: !!(result?.messages || Array.isArray(result)),
  isNull: result === null,
  isUndefined: result === undefined
});

// Warn on empty results
if ((!messages || messages.length === 0) && sessionKey) {
  logger.warn('sessions_history returned empty messages', {
    sessionKey,
    args,
    resultType: typeof result,
    result: result ? JSON.stringify(result).substring(0, 200) : null
  });
}
```

## How to Diagnose

### 1. Check API Logs

When a session shows usage but no messages, check the logs for:

```bash
# Look for the session key in question
grep "Session history loaded" logs/mosbot-api.log | grep "messageCount: 0"

# Check what sessionsHistory returned
grep "sessions_history tool result" logs/mosbot-api.log

# Look for warnings about empty results
grep "sessions_history returned empty messages" logs/mosbot-api.log
```

### 2. Check OpenClaw Gateway Availability

```bash
# Test if OpenClaw Gateway is reachable
curl -X POST http://openclaw.agents.svc.cluster.local:18789/tools/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -d '{
    "tool": "sessions_history",
    "action": "json",
    "args": {
      "sessionKey": "agent:cmo:main",
      "limit": 50
    },
    "sessionKey": "main"
  }'
```

### 3. Compare Session List vs History

```bash
# Get session list (includes last message summary)
curl -X GET "http://localhost:3000/api/v1/openclaw/sessions" \
  -H "Authorization: Bearer $JWT_TOKEN"

# Get session messages (full history)
curl -X GET "http://localhost:3000/api/v1/openclaw/sessions/agent%3Acmo%3Amain/messages?key=agent:cmo:main" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

## Confirmed Root Cause (2026-02-16)

**Agent-to-agent history access is disabled in OpenClaw Gateway.**

When attempting to view messages from agent sessions (e.g., `agent:cmo:main`), OpenClaw returns:

```json
{
  "status": "forbidden",
  "error": "Agent-to-agent history is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent access."
}
```

This explains why:
- Session list shows usage data (from session metadata)
- Session messages are empty (history access is forbidden)

## Solutions

### Solution 1: Enable Agent-to-Agent Access (Recommended)

Enable agent-to-agent history in OpenClaw Gateway configuration:

**Option A: Environment Variable**
```bash
# In OpenClaw Gateway deployment
OPENCLAW_TOOLS_AGENT_TO_AGENT_ENABLED=true
```

**Option B: Configuration File**
```json
{
  "tools": {
    "agentToAgent": {
      "enabled": true
    }
  }
}
```

**For Kubernetes deployment**, update the OpenClaw Gateway deployment:

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

### Solution 2: Detect and Handle Forbidden Response

Update the API to detect the "forbidden" response and provide a better user experience:

```javascript
// In src/routes/openclaw.js after sessionsHistory call
if (historyResult?.details?.status === 'forbidden') {
  logger.warn('Agent-to-agent history access forbidden', {
    sessionKey,
    error: historyResult.details.error
  });
  
  // Return a helpful error message to the UI
  return res.status(403).json({
    error: {
      message: 'Agent session history is not accessible. Enable agent-to-agent access in OpenClaw Gateway.',
      code: 'AGENT_TO_AGENT_DISABLED',
      hint: 'Set tools.agentToAgent.enabled=true in OpenClaw configuration'
    }
  });
}
```

### Solution 3: Fallback to Session List Message

If agent-to-agent access cannot be enabled, fall back to displaying the last message from the session list:

```javascript
// After sessionsHistory returns empty/forbidden
if (messages.length === 0 && session?.messages?.[0]) {
  // Use the last message from session list as fallback
  messages = [session.messages[0]];
  logger.info('Using fallback message from session list', { 
    sessionKey,
    reason: 'Agent-to-agent access disabled'
  });
}
```

## Related Files

- `src/routes/openclaw.js` - Session list and message endpoints
- `src/services/openclawGatewayClient.js` - OpenClaw Gateway client
- `src/components/SessionDetailPanel.jsx` - UI component showing messages

## Testing

To reproduce and test:

1. Find a session with usage data but no messages in the dashboard
2. Note the session key (e.g., `agent:cmo:main`)
3. Check API logs for that session key
4. Manually test the OpenClaw Gateway `sessions_history` tool
5. Compare results with `sessions_list` output

## Status

**✅ Diagnostic logging added** - Monitor logs to identify the specific cause for each occurrence.

**Changes made**:
- Added detailed logging in `src/routes/openclaw.js` for `sessionsHistory()` results
- Added detailed logging in `src/services/openclawGatewayClient.js` for tool invocation
- Fixed logger method (changed `logger.debug` to `logger.info` - debug method not available)

**Next steps**:
1. Collect log data from production instances
2. Identify the most common cause (gateway timeout, tool error, etc.)
3. Implement appropriate solution based on findings

## Changelog

### 2026-02-16
- **Root cause identified**: Agent-to-agent history access is disabled in OpenClaw Gateway
- Added diagnostic logging for empty sessions with usage data
- Fixed logger method call (`logger.debug` → `logger.info`)
- Confirmed via logs: OpenClaw returns `status: "forbidden"` for agent session history
- Solution: Enable `tools.agentToAgent.enabled=true` in OpenClaw Gateway configuration
