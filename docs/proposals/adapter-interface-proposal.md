# Task Management Adapter Interface Proposal

## Overview

This document proposes a generic adapter interface for integrating task management systems (Notion, Mosbot, and future backends) with OpenClaw. The adapter abstracts backend-specific operations into a unified interface.

---

## Common Operations for Notion-Based Task Integrations

Based on typical Notion task management workflows and Mosbot's current capabilities, here are the core operations:

### Task CRUD Operations
- **Read Tasks**: List tasks with filtering (status, assignee, tags, date ranges), pagination, and sorting
- **Get Task**: Fetch single task by ID with full details
- **Create Task**: Create new tasks with title, description, status, assignee, tags, due dates
- **Update Task**: Partial updates to any task field (status transitions, assignee changes, tag updates)
- **Delete Task**: Soft or hard delete with optional archive

### Status Management
- **Update Status**: Move tasks between statuses (PLANNING → TO DO → IN PROGRESS → DONE → ARCHIVE)
- **Status Mapping**: Map between backend-specific status values and canonical statuses
- **Status History**: Track status transitions over time

### Assignment & Ownership
- **Assign Task**: Set assignee (person/user)
- **Update Reporter**: Set task creator/reporter
- **List Assignees**: Get available users/people for assignment
- **User Resolution**: Map between backend user IDs and canonical user identifiers

### Metadata Management
- **Tags**: Add/remove tags, normalize tag formats
- **Priority**: Set/update priority levels (High/Medium/Low)
- **Type**: Set task type (task/bug/feature/improvement/research)
- **Due Dates**: Set/update due dates and handle timezone conversions

### Comments & Activity
- **Add Comment**: Create comments/notes on tasks
- **List Comments**: Retrieve comment history for a task
- **Activity Logs**: Track task activity and changes
- **Task History**: Get audit trail of all changes

### Search & Filtering
- **Search**: Full-text search across task titles and descriptions
- **Filter**: Filter by status, assignee, tags, date ranges, priority
- **Sort**: Sort by created date, updated date, due date, priority

---

## Generic Adapter Interface

### Core Interface Shape

```typescript
interface TaskAdapter {
  // Configuration
  configure(config: AdapterConfig): Promise<void>;
  validateConfig(): Promise<boolean>;
  
  // Task CRUD
  listTasks(options?: ListTasksOptions): Promise<PaginatedTasks>;
  getTask(taskId: string): Promise<Task>;
  createTask(task: CreateTaskInput): Promise<Task>;
  updateTask(taskId: string, updates: UpdateTaskInput): Promise<Task>;
  deleteTask(taskId: string, hard?: boolean): Promise<void>;
  
  // Status Operations
  updateStatus(taskId: string, status: TaskStatus): Promise<Task>;
  getStatusHistory(taskId: string): Promise<StatusTransition[]>;
  
  // Assignment Operations
  assignTask(taskId: string, assigneeId: string): Promise<Task>;
  listAssignees(): Promise<User[]>;
  
  // Comments & Activity
  addComment(taskId: string, comment: CommentInput): Promise<Comment>;
  listComments(taskId: string): Promise<Comment[]>;
  getActivityLogs(taskId: string, options?: PaginationOptions): Promise<ActivityLog[]>;
  getTaskHistory(taskId: string): Promise<TaskHistoryEntry[]>;
  
  // Search & Filter
  searchTasks(query: string, options?: SearchOptions): Promise<PaginatedTasks>;
  
  // Sync Operations
  sync(options?: SyncOptions): Promise<SyncResult>;
  getLastSyncTime(): Promise<Date | null>;
}
```

### Data Models

```typescript
// Core Task Model (canonical format)
interface Task {
  id: string;                    // Backend-specific ID
  externalId?: string;          // Optional external ID (e.g., Notion page ID)
  title: string;
  summary?: string;
  status: TaskStatus;
  priority?: 'High' | 'Medium' | 'Low';
  type?: 'task' | 'bug' | 'feature' | 'improvement' | 'research';
  assigneeId?: string;
  assigneeName?: string;
  reporterId?: string;
  reporterName?: string;
  tags?: string[];
  dueDate?: Date;
  doneAt?: Date;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, any>; // Backend-specific fields
}

// Task Status (canonical)
type TaskStatus = 'PLANNING' | 'TO DO' | 'IN PROGRESS' | 'DONE' | 'ARCHIVE';

// User Model
interface User {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
}

// Comment Model
interface Comment {
  id: string;
  taskId: string;
  content: string;
  authorId?: string;
  authorName?: string;
  createdAt: Date;
}

// Activity Log
interface ActivityLog {
  id: string;
  taskId: string;
  eventType: string;
  description: string;
  actorId?: string;
  actorName?: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

// Pagination
interface PaginationOptions {
  limit?: number;
  offset?: number;
}

interface PaginatedTasks {
  data: Task[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
}

// List Tasks Options
interface ListTasksOptions extends PaginationOptions {
  status?: TaskStatus | TaskStatus[];
  assigneeId?: string;
  reporterId?: string;
  tags?: string[];
  priority?: string;
  includeArchived?: boolean;
  sortBy?: 'createdAt' | 'updatedAt' | 'dueDate' | 'priority';
  sortOrder?: 'asc' | 'desc';
}

// Create/Update Inputs
interface CreateTaskInput {
  title: string;
  summary?: string;
  status?: TaskStatus;
  priority?: 'High' | 'Medium' | 'Low';
  type?: 'task' | 'bug' | 'feature' | 'improvement' | 'research';
  assigneeId?: string;
  reporterId?: string;
  tags?: string[];
  dueDate?: Date;
}

interface UpdateTaskInput extends Partial<CreateTaskInput> {
  // All fields optional for partial updates
}

// Comment Input
interface CommentInput {
  content: string;
  authorId?: string;
}

// Sync Options
interface SyncOptions {
  direction?: 'bidirectional' | 'notion_to_mosbot' | 'mosbot_to_notion';
  since?: Date;
  taskIds?: string[];
}

interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  conflicts: Conflict[];
  completedAt: Date;
}

interface Conflict {
  taskId: string;
  field: string;
  notionValue: any;
  mosbotValue: any;
  resolution?: 'notion' | 'mosbot' | 'manual';
}
```

### Adapter Configuration

```typescript
interface AdapterConfig {
  // Backend type
  type: 'notion' | 'mosbot' | 'jira' | 'linear' | 'asana';
  
  // Authentication
  auth: {
    type: 'bearer' | 'oauth2' | 'api_key' | 'basic';
    token?: string;
    apiKey?: string;
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    tokenEndpoint?: string;
  };
  
  // Backend-specific config
  backend: {
    // Notion-specific
    notionDatabaseId?: string;
    notionWorkspaceId?: string;
    
    // Mosbot-specific
    mosbotApiUrl?: string;
    mosbotWorkspaceId?: string;
    
    // Status mapping (backend status -> canonical status)
    statusMapping?: Record<string, TaskStatus>;
    
    // Field mapping (canonical field -> backend field)
    fieldMapping?: Record<string, string>;
  };
  
  // Sync configuration
  sync?: {
    enabled: boolean;
    strategy: 'polling' | 'webhook';
    interval?: number; // For polling (ms)
    webhookUrl?: string; // For webhooks
    conflictResolution?: 'notion' | 'mosbot' | 'manual' | 'newest';
  };
  
  // Rate limiting
  rateLimit?: {
    requestsPerSecond?: number;
    requestsPerMinute?: number;
  };
}
```

---

## Auth & Configuration Strategy for Mosbot Backend

### Authentication Options

#### Option 1: JWT Bearer Token (Current Mosbot Approach)
```typescript
{
  type: 'mosbot',
  auth: {
    type: 'bearer',
    token: '<jwt_token>'
  },
  backend: {
    mosbotApiUrl: 'https://api.mosbot.example.com',
  }
}
```

**Pros:**
- Simple, stateless
- Already implemented in Mosbot
- Works well for server-to-server

**Cons:**
- Token expiration requires refresh logic
- No OAuth flow for third-party apps

#### Option 2: API Key Authentication
```typescript
{
  type: 'mosbot',
  auth: {
    type: 'api_key',
    apiKey: '<api_key>'
  },
  backend: {
    mosbotApiUrl: 'https://api.mosbot.example.com',
  }
}
```

**Pros:**
- Long-lived credentials
- Simple for integrations
- Can be scoped/permissioned

**Cons:**
- Requires API key management UI
- Security risk if leaked

#### Option 3: OAuth 2.0 (Recommended for Future)
```typescript
{
  type: 'mosbot',
  auth: {
    type: 'oauth2',
    clientId: '<client_id>',
    clientSecret: '<client_secret>',
    tokenEndpoint: 'https://api.mosbot.example.com/oauth/token',
    refreshToken: '<refresh_token>'
  },
  backend: {
    mosbotApiUrl: 'https://api.mosbot.example.com',
  }
}
```

**Pros:**
- Industry standard
- Supports refresh tokens
- Better UX for user authorization
- Can request scoped permissions

**Cons:**
- More complex to implement
- Requires OAuth provider setup

### Configuration Storage

#### For OpenClaw (Client Application)
```typescript
// Store in encrypted config file or environment
interface OpenClawConfig {
  adapters: {
    notion?: AdapterConfig;
    mosbot?: AdapterConfig;
  };
  defaultAdapter: 'notion' | 'mosbot';
  syncSettings: {
    autoSync: boolean;
    syncInterval: number;
  };
}
```

#### For Mosbot API (Server-Side)
```sql
-- New table for adapter configurations
CREATE TABLE adapter_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  adapter_type VARCHAR(50) NOT NULL,
  config JSONB NOT NULL,
  encrypted BOOLEAN DEFAULT true,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT valid_adapter_type CHECK (adapter_type IN ('notion', 'mosbot', 'jira', 'linear'))
);

CREATE INDEX idx_adapter_configs_user ON adapter_configs(user_id);
CREATE INDEX idx_adapter_configs_type ON adapter_configs(adapter_type);
```

### API Endpoints for Adapter Management

```typescript
// POST /api/v1/adapters/config
// Create/update adapter configuration
{
  adapterType: 'notion' | 'mosbot',
  config: AdapterConfig,
  encrypted: boolean
}

// GET /api/v1/adapters/config/:adapterType
// Get adapter configuration (decrypted if user has access)

// DELETE /api/v1/adapters/config/:adapterType
// Remove adapter configuration

// POST /api/v1/adapters/test
// Test adapter connection
{
  adapterType: 'notion' | 'mosbot',
  config: AdapterConfig
}

// POST /api/v1/adapters/sync
// Trigger manual sync
{
  adapterType: 'notion' | 'mosbot',
  options?: SyncOptions
}
```

---

## Sync Strategy Options

### Option 1: Polling (Pull-Based)

**How it works:**
- Adapter periodically queries backend for changes
- Compares timestamps or change logs
- Applies updates to target system

**Implementation:**
```typescript
class PollingSyncStrategy {
  async sync(adapter: TaskAdapter, options: SyncOptions) {
    const lastSync = await adapter.getLastSyncTime();
    const since = options.since || lastSync || new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const tasks = await adapter.listTasks({
      updatedSince: since,
      includeArchived: false
    });
    
    // Process each task
    for (const task of tasks.data) {
      await this.syncTask(task, adapter);
    }
    
    await adapter.updateLastSyncTime(new Date());
  }
}
```

**Pros:**
- Simple to implement
- Works with any backend
- No webhook infrastructure needed
- Reliable (eventually consistent)

**Cons:**
- Higher latency (delay until next poll)
- More API calls (rate limit concerns)
- Can miss rapid changes
- Wastes resources when idle

**Best for:**
- Low-frequency updates
- Backends without webhooks
- Simple integrations
- Development/testing

### Option 2: Webhooks (Push-Based)

**How it works:**
- Backend sends HTTP POST to configured webhook URL on changes
- Adapter processes webhook payload immediately
- Updates target system in real-time

**Implementation:**
```typescript
class WebhookSyncStrategy {
  async setupWebhook(adapter: TaskAdapter, webhookUrl: string) {
    // Register webhook with backend
    await adapter.registerWebhook({
      url: webhookUrl,
      events: ['task.created', 'task.updated', 'task.deleted'],
      secret: this.generateWebhookSecret()
    });
  }
  
  async handleWebhook(payload: WebhookPayload) {
    // Verify webhook signature
    if (!this.verifySignature(payload)) {
      throw new Error('Invalid webhook signature');
    }
    
    // Process event
    switch (payload.event) {
      case 'task.created':
        await this.syncTask(payload.data.taskId);
        break;
      case 'task.updated':
        await this.syncTask(payload.data.taskId);
        break;
      case 'task.deleted':
        await this.deleteTask(payload.data.taskId);
        break;
    }
  }
}
```

**Pros:**
- Real-time updates (low latency)
- Efficient (only processes changes)
- Scales well
- Better user experience

**Cons:**
- Requires webhook infrastructure
- Not all backends support webhooks
- Need to handle webhook failures/retries
- Security considerations (signature verification)

**Best for:**
- Production systems
- Real-time requirements
- High-frequency updates
- Backends with webhook support

### Option 3: Hybrid (Polling + Webhooks)

**How it works:**
- Use webhooks for real-time updates
- Fall back to polling for missed events or webhook failures
- Periodic full sync to catch any gaps

**Implementation:**
```typescript
class HybridSyncStrategy {
  private webhookStrategy: WebhookSyncStrategy;
  private pollingStrategy: PollingSyncStrategy;
  
  async sync(adapter: TaskAdapter, options: SyncOptions) {
    // Try webhook-based sync first
    try {
      await this.webhookStrategy.sync(adapter, options);
    } catch (error) {
      // Fallback to polling
      logger.warn('Webhook sync failed, falling back to polling', error);
      await this.pollingStrategy.sync(adapter, options);
    }
    
    // Periodic full sync (e.g., daily)
    if (this.shouldRunFullSync()) {
      await this.pollingStrategy.sync(adapter, {
        ...options,
        since: null // Full sync
      });
    }
  }
}
```

**Pros:**
- Best of both worlds
- Resilient to failures
- Real-time when possible
- Catches missed events

**Cons:**
- More complex implementation
- Higher resource usage
- More moving parts

**Best for:**
- Production systems requiring reliability
- Critical integrations
- Systems with variable update frequency

### Option 4: Change Data Capture (CDC)

**How it works:**
- Monitor database change logs or event streams
- Stream changes to adapter
- Process updates asynchronously

**Pros:**
- Very efficient
- Low latency
- Captures all changes
- Scales extremely well

**Cons:**
- Requires CDC infrastructure
- Complex to implement
- Backend-specific
- Overkill for many use cases

**Best for:**
- High-scale systems
- Enterprise integrations
- Backends with CDC support

---

## Recommended Approach for Mosbot

### Phase 1: Polling (MVP)
- Start with polling for simplicity
- 5-15 minute intervals
- Track last sync time per adapter
- Implement conflict resolution (newest wins)

### Phase 2: Webhooks (Production)
- Add webhook support to Mosbot API
- Implement webhook registration/management
- Add signature verification
- Fallback to polling on webhook failures

### Phase 3: Hybrid (Optimization)
- Combine webhooks + periodic polling
- Add full sync job (daily)
- Implement conflict detection and resolution UI

---

## Conflict Resolution Strategies

### 1. Last Write Wins (Newest)
- Compare `updatedAt` timestamps
- Keep the most recent version
- **Pros:** Simple, deterministic
- **Cons:** Can lose intentional changes

### 2. Source Priority
- Always prefer one source (e.g., Notion wins)
- **Pros:** Predictable
- **Cons:** One-way sync, loses changes from other source

### 3. Field-Level Merging
- Merge non-conflicting fields
- Flag conflicts for manual resolution
- **Pros:** Preserves most data
- **Cons:** Complex, requires conflict UI

### 4. Manual Resolution
- Detect conflicts
- Present to user for decision
- **Pros:** No data loss
- **Cons:** Requires user interaction

---

## Implementation Recommendations

### Adapter Factory Pattern
```typescript
class TaskAdapterFactory {
  static create(config: AdapterConfig): TaskAdapter {
    switch (config.type) {
      case 'notion':
        return new NotionAdapter(config);
      case 'mosbot':
        return new MosbotAdapter(config);
      default:
        throw new Error(`Unsupported adapter type: ${config.type}`);
    }
  }
}
```

### Error Handling
- Retry with exponential backoff
- Rate limit handling
- Network error recovery
- Validation error reporting

### Logging & Monitoring
- Log all sync operations
- Track sync success/failure rates
- Monitor API rate limits
- Alert on sync failures

### Testing
- Unit tests for each adapter
- Integration tests with mock backends
- E2E tests with real backends (sandbox)
- Conflict resolution tests
