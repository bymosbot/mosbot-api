/**
 * Integration tests for GET /api/v1/openclaw/subagents
 * 
 * Tests verify:
 * - Proper mapping of running/queued/completed subagents
 * - Deduplication by sessionLabel (latest cachedAt wins)
 * - Graceful handling of missing files (empty arrays, still 200)
 * - Service not configured error (503)
 * - Authentication requirements (401)
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const openclawRouter = require('../openclaw');

// Helper to get JWT token for a user
function getToken(userId, role) {
  const jwtSecret = process.env.JWT_SECRET || 'default-secret-change-in-production';
  return jwt.sign(
    { id: userId, role, email: `${role}@example.com` },
    jwtSecret,
    { expiresIn: '1h' }
  );
}

describe('GET /api/v1/openclaw/subagents', () => {
  let app;
  let originalFetch;
  let mockOpenClawUrl;
  let pool;

  beforeAll(() => {
    // Create Express app with routes
    app = express();
    app.use(express.json());
    app.use('/api/v1/openclaw', openclawRouter);
    
    // Add error handler middleware (matching main app)
    app.use((err, req, res, _next) => {
      res.status(err.status || 500).json({
        error: {
          message: err.message || 'Internal server error',
          status: err.status || 500,
        },
      });
    });
    
    // Mock database pool
    pool = require('../../db/pool');
    jest.spyOn(pool, 'query').mockImplementation(async (query, params) => {
      // Mock task number lookup
      if (query.includes('SELECT id, task_number FROM tasks')) {
        const taskIds = params || [];
        return {
          rows: taskIds.map((id, idx) => ({
            id,
            task_number: 100 + idx
          }))
        };
      }
      return { rows: [] };
    });
    
    // Mock fetch globally
    originalFetch = global.fetch;
    mockOpenClawUrl = 'http://mock-openclaw:8080';
    process.env.OPENCLAW_WORKSPACE_URL = mockOpenClawUrl;
  });

  afterAll(() => {
    // Restore original fetch
    global.fetch = originalFetch;
    delete process.env.OPENCLAW_WORKSPACE_URL;
  });

  beforeEach(() => {
    // Reset fetch mock before each test
    global.fetch = jest.fn();
  });

  describe('Happy path: aggregates running/queued/completed subagents', () => {
    it('should return all three categories with proper mapping', async () => {
      const token = getToken('user-id', 'user');
      
      // Mock workspace service responses
      global.fetch = jest.fn().mockImplementation(async (url) => {
        if (url.includes('spawn-active.jsonl')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: '{"sessionKey":"agent:main:cron:abc","sessionLabel":"mosbot-task-123","taskId":"task-123","model":"sonnet","startedAt":"2026-02-10T09:00:00Z","timeoutMinutes":15}\n'
            })
          };
        }
        if (url.includes('spawn-requests.json')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: '{"requests":[{"taskId":"task-456","title":"Test task","status":"SPAWN_QUEUED","model":"sonnet","queuedAt":"2026-02-10T08:00:00Z"}]}'
            })
          };
        }
        if (url.includes('results-cache.jsonl')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: '{"sessionLabel":"mosbot-task-789","taskId":"task-789","cachedAt":"2026-02-09T10:00:00Z","outcome":"✅ Task Complete"}\n'
            })
          };
        }
        if (url.includes('activity-log.jsonl')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: '{"sessionLabel":"mosbot-task-789","timestamp":"2026-02-09T09:45:00Z","event":"agent_start"}\n'
            })
          };
        }
        return { ok: false, status: 404, text: async () => 'Not Found' };
      });

      const response = await request(app)
        .get('/api/v1/openclaw/subagents')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.running).toHaveLength(1);
      expect(response.body.data.queued).toHaveLength(1);
      expect(response.body.data.completed).toHaveLength(1);
      
      // Verify running mapping
      expect(response.body.data.running[0]).toMatchObject({
        sessionKey: 'agent:main:cron:abc',
        sessionLabel: 'mosbot-task-123',
        taskId: 'task-123',
        taskNumber: 100,
        status: 'RUNNING',
        model: 'sonnet',
        startedAt: '2026-02-10T09:00:00Z',
        timeoutMinutes: 15
      });
      
      // Verify queued mapping
      expect(response.body.data.queued[0]).toMatchObject({
        taskId: 'task-456',
        taskNumber: 101,
        title: 'Test task',
        status: 'SPAWN_QUEUED',
        model: 'sonnet',
        queuedAt: '2026-02-10T08:00:00Z'
      });
      
      // Verify completed mapping with activity log enrichment
      expect(response.body.data.completed[0]).toMatchObject({
        sessionLabel: 'mosbot-task-789',
        taskId: 'task-789',
        taskNumber: 102,
        status: 'COMPLETED',
        outcome: '✅ Task Complete',
        startedAt: '2026-02-09T09:45:00Z',
        completedAt: '2026-02-09T10:00:00Z'
      });
      expect(response.body.data.completed[0].durationSeconds).toBe(900); // 15 minutes
      
      // Verify retention metadata
      expect(response.body.data.retention).toBeDefined();
      expect(response.body.data.retention.completedRetentionDays).toBe(30);
      expect(response.body.data.retention.activityLogRetentionDays).toBe(7);
      expect(response.body.data.retention.nextPurgeAt).toBeDefined();
    });
  });

  describe('Deduplication: keeps latest cachedAt entry per sessionLabel', () => {
    it('should deduplicate completed entries by sessionLabel', async () => {
      const token = getToken('user-id', 'user');
      
      global.fetch = jest.fn().mockImplementation(async (url) => {
        if (url.includes('results-cache.jsonl')) {
          // Two entries with same sessionLabel, different cachedAt
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: 
                '{"sessionLabel":"mosbot-task-100","taskId":"task-100","cachedAt":"2026-02-09T10:00:00Z","outcome":"First attempt"}\n' +
                '{"sessionLabel":"mosbot-task-100","taskId":"task-100","cachedAt":"2026-02-09T11:00:00Z","outcome":"Second attempt (latest)"}\n' +
                '{"sessionLabel":"mosbot-task-200","taskId":"task-200","cachedAt":"2026-02-09T12:00:00Z","outcome":"Different task"}\n'
            })
          };
        }
        // Return null/404 for other files
        return { ok: false, status: 404, text: async () => 'Not Found' };
      });

      const response = await request(app)
        .get('/api/v1/openclaw/subagents')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data.completed).toHaveLength(2);
      
      // Find the deduplicated entry
      const dedupedEntry = response.body.data.completed.find(e => e.sessionLabel === 'mosbot-task-100');
      expect(dedupedEntry).toBeDefined();
      expect(dedupedEntry.outcome).toBe('Second attempt (latest)');
      expect(dedupedEntry.completedAt).toBe('2026-02-09T11:00:00Z');
      
      // Verify other entry still exists
      const otherEntry = response.body.data.completed.find(e => e.sessionLabel === 'mosbot-task-200');
      expect(otherEntry).toBeDefined();
      expect(otherEntry.outcome).toBe('Different task');
    });
  });

  describe('Missing files: returns empty arrays, still 200', () => {
    it('should return 200 with empty arrays when all files are missing', async () => {
      const token = getToken('user-id', 'user');
      
      // All files return 404
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Not Found'
      });

      const response = await request(app)
        .get('/api/v1/openclaw/subagents')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.running).toEqual([]);
      expect(response.body.data.queued).toEqual([]);
      expect(response.body.data.completed).toEqual([]);
      expect(response.body.data.retention).toBeDefined();
    });

    it('should handle malformed JSON gracefully', async () => {
      const token = getToken('user-id', 'user');
      
      global.fetch = jest.fn().mockImplementation(async (url) => {
        if (url.includes('spawn-active.jsonl')) {
          // Mix of valid and invalid JSON
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: 
                '{"sessionKey":"valid","sessionLabel":"task-1","taskId":"task-1","status":"RUNNING"}\n' +
                'invalid json line\n' +
                '{"sessionKey":"also-valid","sessionLabel":"task-2","taskId":"task-2","status":"RUNNING"}\n'
            })
          };
        }
        return { ok: false, status: 404, text: async () => 'Not Found' };
      });

      const response = await request(app)
        .get('/api/v1/openclaw/subagents')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data.running).toHaveLength(2); // Only valid entries
      expect(response.body.data.running[0].sessionKey).toBe('valid');
      expect(response.body.data.running[1].sessionKey).toBe('also-valid');
    });
  });

  describe('Service not configured: returns 503', () => {
    it('should return 503 when OPENCLAW_WORKSPACE_URL is not set', async () => {
      const token = getToken('user-id', 'user');
      
      // Temporarily unset workspace URL
      const originalUrl = process.env.OPENCLAW_WORKSPACE_URL;
      delete process.env.OPENCLAW_WORKSPACE_URL;
      process.env.NODE_ENV = 'development'; // Ensure not in production mode

      const response = await request(app)
        .get('/api/v1/openclaw/subagents')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(503);
      expect(response.body.error).toBeDefined();
      expect(response.body.error.message).toContain('not configured');

      // Restore
      process.env.OPENCLAW_WORKSPACE_URL = originalUrl;
    });
  });

  describe('Authentication requirements', () => {
    it('should deny unauthenticated access (401)', async () => {
      const response = await request(app)
        .get('/api/v1/openclaw/subagents');

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Authorization required');
    });

    it('should reject invalid tokens (401)', async () => {
      const response = await request(app)
        .get('/api/v1/openclaw/subagents')
        .set('Authorization', 'Bearer invalid-token');

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Invalid or expired token');
    });

    it('should allow any authenticated user (not just admin)', async () => {
      const token = getToken('user-id', 'user'); // Regular user, not admin
      
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Not Found'
      });

      const response = await request(app)
        .get('/api/v1/openclaw/subagents')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200); // Should succeed for regular user
      expect(response.body.data).toBeDefined();
    });
  });

  describe('Edge cases', () => {
    it('should handle empty spawn-requests.json', async () => {
      const token = getToken('user-id', 'user');
      
      global.fetch = jest.fn().mockImplementation(async (url) => {
        if (url.includes('spawn-requests.json')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: '{"requests":[]}'
            })
          };
        }
        return { ok: false, status: 404, text: async () => 'Not Found' };
      });

      const response = await request(app)
        .get('/api/v1/openclaw/subagents')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data.queued).toEqual([]);
    });

    it('should handle invalid spawn-requests.json format', async () => {
      const token = getToken('user-id', 'user');
      
      global.fetch = jest.fn().mockImplementation(async (url) => {
        if (url.includes('spawn-requests.json')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: 'invalid json'
            })
          };
        }
        return { ok: false, status: 404, text: async () => 'Not Found' };
      });

      const response = await request(app)
        .get('/api/v1/openclaw/subagents')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data.queued).toEqual([]); // Gracefully handles invalid JSON
    });

    it('should compute duration when both startedAt and completedAt are available', async () => {
      const token = getToken('user-id', 'user');
      
      global.fetch = jest.fn().mockImplementation(async (url) => {
        if (url.includes('results-cache.jsonl')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: '{"sessionLabel":"task-duration","taskId":"task-d","cachedAt":"2026-02-10T10:30:00Z","outcome":"Done"}\n'
            })
          };
        }
        if (url.includes('activity-log.jsonl')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: '{"sessionLabel":"task-duration","timestamp":"2026-02-10T10:00:00Z","event":"agent_start"}\n'
            })
          };
        }
        return { ok: false, status: 404, text: async () => 'Not Found' };
      });

      const response = await request(app)
        .get('/api/v1/openclaw/subagents')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      const completed = response.body.data.completed[0];
      expect(completed.startedAt).toBe('2026-02-10T10:00:00Z');
      expect(completed.completedAt).toBe('2026-02-10T10:30:00Z');
      expect(completed.durationSeconds).toBe(1800); // 30 minutes
    });

    it('should leave durationSeconds null when timestamps are unavailable', async () => {
      const token = getToken('user-id', 'user');
      
      global.fetch = jest.fn().mockImplementation(async (url) => {
        if (url.includes('results-cache.jsonl')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: '{"sessionLabel":"task-no-duration","taskId":"task-nd","cachedAt":"2026-02-10T11:00:00Z","outcome":"Done"}\n'
            })
          };
        }
        // No activity log
        return { ok: false, status: 404, text: async () => 'Not Found' };
      });

      const response = await request(app)
        .get('/api/v1/openclaw/subagents')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      const completed = response.body.data.completed[0];
      expect(completed.startedAt).toBeNull();
      expect(completed.durationSeconds).toBeNull();
      expect(completed.completedAt).toBe('2026-02-10T11:00:00Z');
    });

    it('should parse OpenClaw orchestration:spawn events with metadata.session_label', async () => {
      const token = getToken('user-id', 'user');
      
      global.fetch = jest.fn().mockImplementation(async (url) => {
        if (url.includes('results-cache.jsonl')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: '{"sessionLabel":"mosbot-task-openclaw","taskId":"task-oc","cachedAt":"2026-02-10T12:30:00Z","outcome":"✅ Complete"}\n'
            })
          };
        }
        if (url.includes('activity-log.jsonl')) {
          // New OpenClaw format with category and nested metadata
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: '{"timestamp":"2026-02-10T12:00:00Z","task_id":"task-oc","task_number":"34","category":"orchestration:spawn","title":"Subagent spawned","metadata":{"session_label":"mosbot-task-openclaw","model":"sonnet"}}\n'
            })
          };
        }
        return { ok: false, status: 404, text: async () => 'Not Found' };
      });

      const response = await request(app)
        .get('/api/v1/openclaw/subagents')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      const completed = response.body.data.completed[0];
      expect(completed.sessionLabel).toBe('mosbot-task-openclaw');
      expect(completed.startedAt).toBe('2026-02-10T12:00:00Z');
      expect(completed.completedAt).toBe('2026-02-10T12:30:00Z');
      expect(completed.durationSeconds).toBe(1800); // 30 minutes
    });
  });
});
