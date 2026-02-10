# Fix: Subagent "Started N/A" and "Duration N/A" Issue

**Date**: 2026-02-10  
**Issue**: Subagents page showing "Started N/A" and "Duration N/A" for all completed subagents  
**Root Cause**: API code was looking for wrong field names and event types in OpenClaw activity log

---

## Problem Analysis

### What Was Happening

The API endpoint `/api/v1/openclaw/subagents` was unable to extract start timestamps from the activity log because:

1. **Wrong field names**: Code looked for `entry.sessionLabel` but activity log uses `entry.metadata.session_label`
2. **Wrong event types**: Code looked for `agent_start` or `subagent_start` events, but OpenClaw writes `orchestration:spawn` category
3. **Wrong task ID field**: Code looked for `entry.taskId` but activity log uses `entry.task_id` (with underscore)

### Data Structure Discovery

OpenClaw writes activity log entries with this structure:

```json
{
  "timestamp": "2026-02-10T01:07:45.333Z",
  "task_id": "c45f7bf7-7ea5-42fd-a684-2b5c4af7d2eb",
  "task_number": "34",
  "category": "orchestration:spawn",
  "title": "Subagent spawned",
  "description": "...",
  "metadata": {
    "session_label": "mosbot-task-...",
    "model": "sonnet",
    "title": "..."
  }
}
```

---

## Solution Implemented

### Changes Made

**File**: `src/routes/openclaw.js`

#### 1. Fixed Activity Log Parsing (lines 351-363)

**Before**:
```javascript
activityEntries.forEach(entry => {
  const key = entry.sessionLabel || entry.taskId;
  if (key) {
    if (!activityBySession.has(key)) {
      activityBySession.set(key, []);
    }
    activityBySession.get(key).push(entry);
  }
});
```

**After**:
```javascript
activityEntries.forEach(entry => {
  // Activity log uses metadata.session_label and task_id (with underscore)
  const sessionLabel = entry.metadata?.session_label || entry.sessionLabel;
  const taskId = entry.task_id || entry.taskId;
  const key = sessionLabel || taskId;
  
  if (key) {
    if (!activityBySession.has(key)) {
      activityBySession.set(key, []);
    }
    activityBySession.get(key).push(entry);
  }
});
```

**Why**: Now correctly extracts `session_label` from nested `metadata` object and handles both `task_id` (underscore) and `taskId` (camelCase) formats.

#### 2. Fixed Start Event Detection (lines 393-399)

**Before**:
```javascript
const startEvent = activities.find(a => 
  a.event === 'agent_start' || 
  a.event === 'subagent_start' ||
  (a.timestamp && !a.event)
);
```

**After**:
```javascript
// Look for orchestration:spawn event which marks subagent start
const startEvent = activities.find(a => 
  a.category === 'orchestration:spawn' ||
  a.event === 'agent_start' || 
  a.event === 'subagent_start' ||
  (a.timestamp && !a.event)
);
```

**Why**: Now looks for the actual event type that OpenClaw writes (`orchestration:spawn` in the `category` field) while maintaining backward compatibility with other event types.

---

## Testing

### Expected Behavior After Fix

1. **Completed subagents** should now show:
   - **Started**: Relative time (e.g., "2 days ago") instead of "N/A"
   - **Duration**: Formatted duration (e.g., "5m 23s") instead of "N/A"

2. **Duration calculation**: Automatically computed as `completedAt - startedAt`

### Test Steps

1. Deploy updated API code
2. Navigate to `/subagents` page
3. Click "Completed" filter
4. Verify that completed subagents show:
   - Started timestamp (relative format)
   - Duration in human-readable format

### Sample Data

Based on the activity log analysis, we have 4 completed subagents:
- TASK-22, TASK-23, TASK-25, TASK-33

All should now display start times and durations.

---

## Technical Details

### Field Mapping

| Data Source | OpenClaw Field | API Expected | Fix Applied |
|------------|----------------|--------------|-------------|
| Activity log | `metadata.session_label` | `sessionLabel` | ✅ Added fallback |
| Activity log | `task_id` | `taskId` | ✅ Added fallback |
| Activity log | `category: "orchestration:spawn"` | `event: "agent_start"` | ✅ Added category check |
| Activity log | `timestamp` | `timestamp` | ✅ Already correct |

### Backward Compatibility

The fix maintains backward compatibility by:
- Checking for both old and new field names using `||` fallback
- Keeping existing event type checks (`agent_start`, `subagent_start`)
- Using optional chaining (`?.`) to safely access nested properties

---

## Files Changed

- `src/routes/openclaw.js` - Updated activity log parsing and start event detection

## Deployment Notes

- No database migrations required
- No environment variable changes
- No breaking changes to API response format
- Safe to deploy without downtime

---

## Related Issues

- Dashboard issue: "Started N/A" and "Duration N/A" on Subagents page
- Root cause: Mismatch between OpenClaw data structure and API parsing logic
