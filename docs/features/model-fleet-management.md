# Model Fleet Management

## Overview

The Model Fleet feature provides a UI and API for managing AI models available in MosBot. **OpenClaw config is the source of truth** for all model definitions.

## Architecture

```
┌─────────────────────────────────────────────┐
│ MosBot Dashboard                            │
│ /settings/model-fleet page                 │
│ (View/Edit models, admin-only CRUD)        │
└─────────────────┬───────────────────────────┘
                  │ REST API
                  │
┌─────────────────▼───────────────────────────┐
│ MosBot API                                  │
│ /api/v1/admin/models (CRUD endpoints)      │
│ /api/v1/models (public list endpoint)      │
└─────────────────┬───────────────────────────┘
                  │ Read/Write via
                  │ OpenClaw Workspace Service
                  │
┌─────────────────▼───────────────────────────┐
│ OpenClaw                                    │
│ openclaw.json → global.models section      │
│ (Source of Truth)                           │
└─────────────────────────────────────────────┘
```

### Key Principles

1. **OpenClaw is the Source of Truth**: All model definitions live in `openclaw.json` under `global.models`.
2. **No Database Storage**: Models are NOT stored in PostgreSQL; all CRUD operations modify the OpenClaw config file.
3. **Hot Reload**: OpenClaw automatically reloads configuration changes (no manual restart required by default).
4. **Admin-Only CRUD**: Only authenticated admin/agent/owner users can create, update, or delete models.

## OpenClaw Config Structure

Models are stored in `openclaw.json` under the `agents.defaults.models` section:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "openrouter/anthropic/claude-sonnet-4.5"
      },
      "models": {
        "openrouter/anthropic/claude-sonnet-4.5": {
          "alias": "sonnet",
          "params": {
            "maxTokens": 8000,
            "temperature": 0.7
          }
        },
        "openrouter/openai/gpt-4": {
          "alias": "gpt4",
          "params": {
            "maxTokens": 4000
          }
        }
      }
    }
  }
}
```

**Note:** The default/primary model is set in `agents.defaults.model.primary`, NOT in a separate `defaultModel` field.

### Model Object Schema

**Only these fields are supported by OpenClaw:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `alias` | string | Yes | Short display name for the model (e.g., "sonnet", "kimi") |
| `params` | object | Yes | Model-specific parameters |

**Supported `params` fields** (from OpenClaw docs):
- `temperature` (number, 0-2) - Randomness level
- `maxTokens` (number) - Maximum tokens in response (default: 8192)
- `contextWindow` (number) - Context window size
- `cacheControlTtl` (string) - Cache TTL for prompt caching (e.g., '1h')
- `cacheRetention` (string) - Cache strategy: 'short', 'medium', or 'long'
- `reasoning` (boolean) - Enable reasoning mode

**Fields NOT supported** (will be ignored or cause errors):
- ❌ `description` - Not part of OpenClaw schema
- ❌ `provider` - Not part of OpenClaw schema (inferred from model ID)
- ❌ `enabled` - Not part of OpenClaw schema (use model allowlist instead)

## API Endpoints

### Public Endpoint

#### `GET /api/v1/models`

Returns list of available models for use in dropdowns and UI components.

**Response:**
```json
{
  "data": {
    "models": [
      {
        "id": "openrouter/anthropic/claude-sonnet-4.5",
        "name": "sonnet",
        "params": { "maxTokens": 8000 },
        "isDefault": true
      }
    ],
    "defaultModel": "openrouter/anthropic/claude-sonnet-4.5"
  }
}
```

### Admin Endpoints

All admin endpoints require `authenticateToken` and `requireAdmin` middleware.

#### `GET /api/v1/admin/models`

List all models with optional filtering.

**Query Parameters:**
- `search` (string): Filter by model ID or alias

**Response:**
```json
{
  "data": [
    {
      "id": "openrouter/anthropic/claude-sonnet-4.5",
      "alias": "sonnet",
      "params": { "maxTokens": 8000 },
      "is_default": true
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 1
  }
}
```

#### `POST /api/v1/admin/models`

Create a new model in OpenClaw config.

**Request Body:**
```json
{
  "id": "openrouter/anthropic/claude-sonnet-4.5",
  "alias": "Claude Sonnet 4.5",
  "description": "Latest Claude model",
  "provider": "anthropic",
  "params": { "maxTokens": 8000 },
  "enabled": true
}
```

**Validation:**
- `id` is required, must be unique, max 200 characters
- `alias` is required, non-empty string
- `params` must be an object (not an array)

**Response:** `201 Created` with model data

#### `PUT /api/v1/admin/models/:modelId(*)`

Update an existing model.

**Note:** Uses wildcard route parameter (`/:modelId(*)`) to support model IDs with slashes.

**Request Body:**
```json
{
  "alias": "sonnet-updated",
  "params": { "maxTokens": 16000, "temperature": 0.5 }
}
```

**Validation:**
- All fields are optional (partial updates supported)

**Response:** `200 OK` with updated model data

#### `DELETE /api/v1/admin/models/:modelId(*)`

Delete a model from OpenClaw config.

**Validation:**
- Cannot delete the default model (set a new default first)

**Response:** `200 OK` with `{ data: { success: true, id: "..." } }`

#### `PATCH /api/v1/admin/models/:modelId(*)/default`

Set a model as the primary/default model. Updates `agents.defaults.model.primary` in OpenClaw config.

**Response:** `200 OK` with model data where `is_default: true`

**Example:**
```bash
PATCH /api/v1/admin/models/openrouter%2Fanthropiclaude-sonnet-4.5/default
```

This will set `agents.defaults.model.primary = "openrouter/anthropic/claude-sonnet-4.5"` in `openclaw.json`.

## Config Reload Behavior

OpenClaw automatically watches `openclaw.json` for changes and reloads the configuration based on the `gateway.reload.mode` setting:

| Mode | Behavior |
|------|----------|
| `off` | No config reload (manual restart required) |
| `hot` | Apply only hot-safe changes |
| `restart` | Restart on reload-required changes |
| `hybrid` (default) | Hot-apply when safe, restart when required |

**For model changes**: Model updates are typically hot-reloadable, meaning:
- ✅ Adding a new model: Hot-reloaded immediately
- ✅ Updating model params: Hot-reloaded immediately
- ✅ Changing default model: Hot-reloaded immediately
- ⚠️ Deleting a model in use: May require restart depending on usage

**No manual restart endpoint is needed** because OpenClaw handles this automatically.

## Dashboard UI

### Route

`/settings/model-fleet`

### Features

- **View-only for non-admin users**: Shows all models but disables CRUD actions
- **Admin capabilities**:
  - Add new models via "Add Model" button
  - Edit existing models (pencil icon)
  - Delete models (trash icon)
  - Set default model (star icon)
- **Search**:
  - Text search (model ID, alias)
- **Model cards**:
  - Display alias and model ID
  - Show parameter count and values
  - Visual indicators for default model (gold star icon)
  - Default model always appears first in the list

### Components

- `src/pages/ModelFleetSettings.jsx` - Main page with list, search, and CRUD actions
- `src/components/ModelModal.jsx` - Add/Edit modal with guided form for all OpenClaw params
- `src/components/ModelDeleteConfirmModal.jsx` - Delete confirmation

### Model Form (Guided Input)

The Add/Edit Model modal provides a **structured form** instead of raw JSON to prevent config errors:

**Form Fields:**
1. **Model ID** (text) - Full model identifier (e.g., `openrouter/anthropic/claude-sonnet-4.5`)
2. **Alias** (text, required) - Short display name (e.g., `sonnet`, `kimi`)
3. **Max Tokens** (number) - Maximum tokens in response
4. **Temperature** (number, 0-2, step 0.1) - Randomness level
5. **Context Window** (number) - Context window size in tokens
6. **Cache Control TTL** (text) - Cache TTL (e.g., `1h`, `30m`, `2d`)
7. **Cache Retention** (dropdown) - Strategy: None, Short, Medium, Long
8. **Reasoning** (checkbox) - Enable reasoning mode

**Benefits:**
- ✅ Type validation (numbers, ranges, enums)
- ✅ Prevents JSON syntax errors
- ✅ Clear descriptions for each parameter
- ✅ Only valid OpenClaw params are accepted

## Testing

### API Tests

**`src/routes/__tests__/models.test.js`:**
- Tests public GET endpoint
- Mocks OpenClaw workspace client
- Verifies response shape and backward compatibility

**`src/routes/admin/__tests__/models.test.js`:**
- Tests all CRUD endpoints
- Validates authentication/authorization
- Tests validation rules (can't delete default, can't disable default, etc.)

**Run tests:**
```bash
npm test -- src/routes/__tests__/models.test.js
npm test -- src/routes/admin/__tests__/models.test.js
```

## Migration from File-Based Models

The old `src/config/models.json` file is now **deprecated**. To migrate:

1. **Manually copy models** from `models.json` to `openclaw.json`:
   ```bash
   # Read current models.json
   cat src/config/models.json
   
   # Add to openclaw.json under global.models
   # (Use the /api/v1/admin/models POST endpoint or edit openclaw.json directly)
   ```

2. **Remove the old file** once migration is complete:
   ```bash
   rm src/config/models.json
   ```

## Security

- All CRUD operations require `authenticateToken` middleware
- All CRUD operations require `requireAdmin` middleware (admin, agent, or owner role)
- OpenClaw workspace service endpoints have their own authentication
- Model IDs are validated to prevent injection attacks
- File writes are atomic (OpenClaw handles file locking)

## Troubleshooting

### "OpenClaw workspace service is not configured"

**Cause:** `OPENCLAW_WORKSPACE_URL` is not set.

**Solution:** Set environment variable:
```bash
export OPENCLAW_WORKSPACE_URL=http://openclaw-workspace.agents.svc.cluster.local:8080
```

### "Cannot delete the default model"

**Cause:** Attempting to delete or disable the model set in `global.defaultModel`.

**Solution:** Set a new default model first via `PATCH /api/v1/admin/models/:modelId/default`.

### Changes not taking effect

**Cause:** OpenClaw reload mode may be set to `off`.

**Solution:** Check `gateway.reload.mode` in OpenClaw config. Set to `hybrid` (recommended) or `restart`.

### Model ID with slashes returns 404

**Cause:** Express.js routing issue with slashes in URL params.

**Solution:** Already handled by wildcard route `/:modelId(*)` in admin endpoints. Ensure client encodes slashes in URLs.

## Future Enhancements

- [ ] Add model cost/pricing metadata
- [ ] Add model capability tags (vision, function calling, etc.)
- [ ] Add model performance metrics (tokens/sec, latency)
- [ ] Add bulk import/export for models
- [ ] Add model usage analytics (which models are used most)
- [ ] Add model versioning/history
- [ ] Add model testing/validation UI
