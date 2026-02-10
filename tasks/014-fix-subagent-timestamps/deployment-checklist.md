# Deployment Checklist: Fix Subagent Timestamps

**Task**: Fix "Started N/A" and "Duration N/A" on Subagents page  
**Date**: 2026-02-10  
**Risk Level**: 🟢 Low

---

## Pre-Deployment Checks

### Code Quality
- ✅ All tests passing (13/13 tests in openclaw.subagents.test.js)
- ✅ No linter errors
- ✅ Backward compatibility maintained
- ✅ New test added for OpenClaw format

### Files Changed
- ✅ `src/routes/openclaw.js` - Activity log parsing and event detection
- ✅ `src/routes/__tests__/openclaw.subagents.test.js` - Added test for new format

### Dependencies
- ✅ No new dependencies added
- ✅ No package.json changes
- ✅ No environment variable changes

---

## Deployment Steps

### 1. Build & Test
```bash
cd /Users/mosufy/Documents/webapps/Mosbot/mosbot-api
npm test
```

Expected: All tests pass

### 2. Commit Changes
```bash
git add src/routes/openclaw.js
git add src/routes/__tests__/openclaw.subagents.test.js
git add tasks/014-fix-subagent-timestamps/

git commit -m "Fix subagent timestamps parsing from OpenClaw activity log

- Parse metadata.session_label and task_id from activity log
- Detect orchestration:spawn events for start times
- Maintain backward compatibility with old event types
- Add test for new OpenClaw data format

Fixes: Started N/A and Duration N/A on Subagents page"
```

### 3. Deploy API
```bash
# Build Docker image
docker build -t mosbot-api:fix-subagent-timestamps .

# Tag for registry
docker tag mosbot-api:fix-subagent-timestamps ghcr.io/mosufy/mosbot-api:latest

# Push to registry
docker push ghcr.io/mosufy/mosbot-api:latest

# Update Kubernetes deployment
kubectl rollout restart deployment/mosbot-api -n mosbot
```

### 4. Verify Deployment
```bash
# Check pod status
kubectl get pods -n mosbot -l app=mosbot-api

# Check logs
kubectl logs -n mosbot -l app=mosbot-api --tail=50
```

---

## Post-Deployment Verification

### API Health Check
1. Check API is responding:
   ```bash
   curl https://api.bymos.dev/health
   ```
   Expected: `{"status":"ok"}`

### Subagents Endpoint Test
2. Test subagents endpoint:
   ```bash
   curl -H "Authorization: Bearer <token>" \
        https://api.bymos.dev/api/v1/openclaw/subagents
   ```
   Expected: JSON with `running`, `queued`, `completed` arrays

### Dashboard Verification
3. Navigate to https://mosbot.bymos.dev/subagents
4. Click "Completed" filter
5. Verify completed subagents show:
   - ✅ **Started**: Relative time (e.g., "2 days ago") instead of "N/A"
   - ✅ **Duration**: Formatted time (e.g., "5m 23s") instead of "N/A"

### Expected Results
Based on the data analysis:
- TASK-22: Should show start time and duration
- TASK-23: Should show start time and duration
- TASK-25: Should show start time and duration
- TASK-33: Should show start time and duration

---

## Rollback Plan

If issues occur:

### 1. Quick Rollback
```bash
# Rollback to previous deployment
kubectl rollout undo deployment/mosbot-api -n mosbot

# Verify rollback
kubectl rollout status deployment/mosbot-api -n mosbot
```

### 2. Verify Rollback
- Check API health endpoint
- Verify subagents page loads (will show N/A again)

---

## Monitoring

### Metrics to Watch
- API response times for `/api/v1/openclaw/subagents`
- Error rates in API logs
- User reports of subagents page issues

### Logs to Monitor
```bash
# Watch API logs
kubectl logs -n mosbot -l app=mosbot-api -f | grep -i "subagent\|activity"
```

Look for:
- ✅ "Fetching subagent status" - Normal operation
- ⚠️ "Failed to parse" - Parsing errors (should be rare)
- ❌ "OpenClaw workspace service error" - Service connectivity issues

---

## Known Issues / Limitations

### None Expected
- Backward compatible with old event format
- Gracefully handles missing data (returns null)
- No breaking changes to API response format

### If Timestamps Still Show N/A

Possible causes:
1. **Activity log is empty**: No `orchestration:spawn` events written yet
2. **Session label mismatch**: `results-cache` and `activity-log` have different session labels
3. **OpenClaw not writing events**: OpenClaw service needs to be updated

Debug steps:
```bash
# Check activity log content
curl -H "Authorization: Bearer <token>" \
     "https://api.bymos.dev/api/v1/openclaw/workspace/files/content?path=/runtime/mosbot/activity-log.jsonl"

# Check results cache content
curl -H "Authorization: Bearer <token>" \
     "https://api.bymos.dev/api/v1/openclaw/workspace/files/content?path=/runtime/mosbot/results-cache.jsonl"
```

---

## Success Criteria

- ✅ API tests pass
- ✅ No errors in deployment
- ✅ Subagents page shows timestamps instead of "N/A"
- ✅ No increase in error rates
- ✅ No user complaints

---

## Contact

If issues arise:
- Check API logs: `kubectl logs -n mosbot -l app=mosbot-api`
- Check OpenClaw logs: `kubectl logs -n openclaw -l app=openclaw-workspace`
- Review fix summary: `tasks/014-fix-subagent-timestamps/fix-summary.md`
