# Task Management Adapter Interface Proposal

This document was moved from `docs/proposals/adapter-interface-proposal.md` to `docs/decisions/adapter-interface-proposal.md` so design proposals/decisions live in one place.

---

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
  id: string; // Backend-specific ID
  externalId?: string; // Optional external ID (e.g., Notion page ID)
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

## Notes

- This is a proposal document. Treat it as a starting point; final interface should align with actual Mosbot public API contract and OpenClaw adapter needs.
- Mosbot’s contract surface (current): `docs/api/openclaw-public-api.md`
