# Local Development Setup - Agent Auto-Discovery

Your local Mosbot API needs to connect to OpenClaw to fetch the agent list (COO, CTO, CMO, CPO).

## ✅ Current Status

- ✅ Port-forward is running: `localhost:8080` → OpenClaw workspace service
- ⚠️ Need to update local `.env` file
- ⚠️ Need to restart API

---

## 🔧 Setup Steps

### 1. Update Your `.env` File

Open `/Users/mosufy/Documents/webapps/Mosbot/mosbot-api/.env` and ensure these lines exist:

```bash
# OpenClaw Workspace Integration (for agent auto-discovery)
OPENCLAW_WORKSPACE_URL=http://localhost:8080
OPENCLAW_WORKSPACE_TOKEN=your-workspace-token-change-in-production
```

**Note**: The token can be anything for local dev since the workspace service doesn't enforce auth in local mode.

### 2. Restart the API

Your `nodemon` should auto-restart, but if not:

```bash
# In your mosbot-api directory
docker-compose restart mosbot-api

# Or if running npm directly:
npm run dev
```

### 3. Verify Agents Endpoint (Without Auth)

The `/agents` endpoint might be public (no auth required):

```bash
curl http://localhost:3000/api/v1/openclaw/agents
```

Expected response:
```json
[
  {
    "id": "coo",
    "name": "MostBot",
    "label": "MostBot (COO)",
    "description": "chief operating officer and task orchestrator",
    "workspaceRootPath": "/workspace-coo",
    "icon": "📊",
    "isDefault": true
  },
  {
    "id": "cpo",
    "name": "Alex",
    "label": "Alex (CPO)",
    "description": "product strategist",
    "workspaceRootPath": "/workspace-cpo",
    "icon": "💡",
    "isDefault": false
  },
  {
    "id": "cto",
    "name": "Elon",
    "label": "Elon (CTO)",
    "description": "tech architect",
    "workspaceRootPath": "/workspace-cto",
    "icon": "💼",
    "isDefault": false
  },
  {
    "id": "cmo",
    "name": "Gary",
    "label": "Gary (CMO)",
    "description": "marketing strategist",
    "workspaceRootPath": "/workspace-cmo",
    "icon": "📢",
    "isDefault": false
  }
]
```

---

## 🎯 Testing in the Dashboard

Once the API is configured:

1. Open your dashboard: `http://localhost:5173`
2. Login if needed
3. Navigate to **Workspaces** 
4. You should see a dropdown with all 4 agents:
   - 📊 MostBot (COO)
   - 💡 Alex (CPO)
   - 💼 Elon (CTO)
   - 📢 Gary (CMO)

---

## 🐛 Troubleshooting

### Error: "OpenClaw workspace service is not configured"

**Cause**: `OPENCLAW_WORKSPACE_URL` is not set in `.env`

**Fix**: Add to `.env`:
```bash
OPENCLAW_WORKSPACE_URL=http://localhost:8080
```

### Error: Connection refused on port 8080

**Cause**: Port-forward is not running

**Fix**: Start it in a separate terminal:
```bash
kubectl port-forward -n openclaw-personal svc/openclaw-workspace 8080:8080
```

**Check if running**:
```bash
lsof -i :8080 | grep kubectl
```

### Error: Cannot connect to OpenClaw

**Cause**: OpenClaw pod might not be ready

**Check pod status**:
```bash
kubectl get pod -n openclaw-personal -l app=openclaw
```

**Check logs**:
```bash
kubectl logs -n openclaw-personal -l app=openclaw -c openclaw --tail=50
```

### Error: Agents endpoint returns 401 Unauthorized

**Cause**: You're hitting an authenticated endpoint

**Fix**: The `/agents` endpoint should be public. Check if the route is protected:
- File: `mosbot-api/src/routes/openclaw.js`
- Line: Look for `router.get('/agents', ...)`
- It should NOT have `requireAuth` middleware

---

## 🚀 Quick Start Command

Run this to set everything up:

```bash
# 1. Start port-forward (keep this terminal open)
kubectl port-forward -n openclaw-personal svc/openclaw-workspace 8080:8080 &

# 2. Update .env (add OPENCLAW_WORKSPACE_URL)
echo "OPENCLAW_WORKSPACE_URL=http://localhost:8080" >> .env

# 3. Restart API
docker-compose restart mosbot-api

# 4. Test agents endpoint
sleep 5 && curl http://localhost:3000/api/v1/openclaw/agents | jq
```

---

## 📝 Note on Port-Forward

The port-forward **must remain running** while you're developing locally. If you close the terminal or restart your machine, you'll need to run it again.

Consider adding this to your development startup script or use a tool like `tmux` to keep it running in the background.

---

**Need help?** Check the error logs in your `mosbot-api` terminal or the port-forward log at `/tmp/openclaw-port-forward.log`.
