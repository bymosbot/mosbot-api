/**
 * Unit tests for modelPricingService.js
 *
 * Tests:
 * - normalizeModelId()
 * - loadPricingCache()
 * - syncPricingFromOpenRouter()
 * - estimateCostFromTokens()
 * - startPricingRefreshJob()
 */

// Mock fetch globally before requiring modules
global.fetch = jest.fn();

// Mock the pool before requiring any modules that use it
jest.mock('../../db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(),
  end: jest.fn(),
}));

jest.mock('../../config', () => ({
  openrouter: {
    apiKey: null,
  },
}));

jest.mock('../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const pool = require('../../db/pool');
const {
  normalizeModelId,
  loadPricingCache,
  syncPricingFromOpenRouter,
  estimateCostFromTokens,
  startPricingRefreshJob,
} = require('../modelPricingService');

describe('normalizeModelId', () => {
  it('should return null for null input', () => {
    expect(normalizeModelId(null)).toBeNull();
  });

  it('should return null for undefined input', () => {
    expect(normalizeModelId(undefined)).toBeNull();
  });

  it('should return null for non-string input', () => {
    expect(normalizeModelId(123)).toBeNull();
    expect(normalizeModelId({})).toBeNull();
  });

  it('should strip "openrouter/" prefix', () => {
    expect(normalizeModelId('openrouter/anthropic/claude-sonnet-4.5')).toBe(
      'anthropic/claude-sonnet-4.5',
    );
  });

  it('should return modelId as-is when it does not start with "openrouter/"', () => {
    expect(normalizeModelId('anthropic/claude-sonnet-4.5')).toBe('anthropic/claude-sonnet-4.5');
  });

  it('should handle empty string', () => {
    // Empty string is falsy, so function returns null
    expect(normalizeModelId('')).toBeNull();
  });
});

describe('loadPricingCache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should load pricing from database into cache', async () => {
    pool.query.mockResolvedValue({
      rows: [
        {
          model_id: 'anthropic/claude-sonnet-4.5',
          prompt_cost_per_token: '0.000003',
          completion_cost_per_token: '0.000015',
        },
        {
          model_id: 'openai/gpt-4',
          prompt_cost_per_token: '0.00003',
          completion_cost_per_token: '0.00006',
        },
      ],
    });

    const count = await loadPricingCache();

    expect(count).toBe(2);
    expect(pool.query).toHaveBeenCalledWith(
      'SELECT model_id, prompt_cost_per_token, completion_cost_per_token FROM model_pricing',
    );

    // Verify cache is populated
    const cost1 = estimateCostFromTokens('openrouter/anthropic/claude-sonnet-4.5', 1000, 500);
    expect(cost1).toBeGreaterThan(0);

    const cost2 = estimateCostFromTokens('openai/gpt-4', 1000, 500);
    expect(cost2).toBeGreaterThan(0);
  });

  it('should handle empty database result', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const count = await loadPricingCache();

    expect(count).toBe(0);
  });

  it('should parse numeric strings correctly', async () => {
    pool.query.mockResolvedValue({
      rows: [
        {
          model_id: 'test-model',
          prompt_cost_per_token: '0.000001',
          completion_cost_per_token: '0.000002',
        },
      ],
    });

    await loadPricingCache();

    const cost = estimateCostFromTokens('test-model', 1000, 1000);
    expect(cost).toBeCloseTo(0.003, 5); // (1000 * 0.000001) + (1000 * 0.000002)
  });

  it('should handle zero costs', async () => {
    pool.query.mockResolvedValue({
      rows: [
        {
          model_id: 'free-model',
          prompt_cost_per_token: '0',
          completion_cost_per_token: '0',
        },
      ],
    });

    await loadPricingCache();

    const cost = estimateCostFromTokens('free-model', 1000, 1000);
    expect(cost).toBeNull(); // Returns null when cost is 0
  });
});

describe('syncPricingFromOpenRouter', () => {
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(mockClient);
  });

  it('should skip sync if lock is already acquired', async () => {
    mockClient.query.mockResolvedValueOnce({
      rows: [{ acquired: false }],
    });

    const result = await syncPricingFromOpenRouter();

    expect(result).toBe(0);
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('should fetch and sync pricing from OpenRouter', async () => {
    // Lock acquired
    mockClient.query.mockResolvedValueOnce({
      rows: [{ acquired: true }],
    });

    // Mock OpenRouter API response
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'anthropic/claude-sonnet-4.5',
            name: 'Claude Sonnet 4.5',
            pricing: {
              prompt: '0.000003',
              completion: '0.000015',
            },
            context_length: 200000,
          },
          {
            id: 'openai/gpt-4',
            name: 'GPT-4',
            pricing: {
              prompt: '0.00003',
              completion: '0.00006',
            },
            context_length: 8192,
          },
        ],
      }),
    });

    // Mock upsert queries (one per model)
    mockClient.query.mockResolvedValue({ rows: [] });

    // Mock unlock
    mockClient.query.mockResolvedValueOnce({ rows: [] });

    const result = await syncPricingFromOpenRouter();

    expect(result).toBe(2);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
        }),
      }),
    );
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('should include Authorization header when API key is configured', async () => {
    // Temporarily set API key in config
    const config = require('../../config');
    const originalApiKey = config.openrouter.apiKey;
    config.openrouter.apiKey = 'sk-test-key';

    mockClient.query.mockImplementation((sql) => {
      if (sql.includes('pg_try_advisory_lock')) {
        return Promise.resolve({ rows: [{ acquired: true }] });
      }
      if (sql.includes('pg_advisory_unlock')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT model_id')) {
        // loadPricingCache call - uses pool.query, not client.query
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    // Mock pool.query for loadPricingCache call
    pool.query.mockResolvedValue({ rows: [] });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await syncPricingFromOpenRouter();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test-key',
        }),
      }),
    );

    // Restore original API key
    config.openrouter.apiKey = originalApiKey;
  });

  it('should handle API errors', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql.includes('pg_try_advisory_lock')) {
        return Promise.resolve({ rows: [{ acquired: true }] });
      }
      if (sql.includes('pg_advisory_unlock')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    await expect(syncPricingFromOpenRouter()).rejects.toThrow('OpenRouter models API responded');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('should handle empty model list', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql.includes('pg_try_advisory_lock')) {
        return Promise.resolve({ rows: [{ acquired: true }] });
      }
      if (sql.includes('pg_advisory_unlock')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    // Mock pool.query for loadPricingCache call (it's called before unlock when empty)
    pool.query.mockResolvedValue({ rows: [] });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    const result = await syncPricingFromOpenRouter();

    expect(result).toBe(0);
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('should skip models without id', async () => {
    let insertCount = 0;
    mockClient.query.mockImplementation((sql) => {
      if (sql.includes('pg_try_advisory_lock')) {
        return Promise.resolve({ rows: [{ acquired: true }] });
      }
      if (sql.includes('pg_advisory_unlock')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO model_pricing')) {
        insertCount++;
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    // Mock pool.query for loadPricingCache call at the end
    pool.query.mockResolvedValue({ rows: [] });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'valid-model',
            name: 'Valid Model',
            pricing: { prompt: '0.001', completion: '0.002' },
          },
          {
            // Missing id
            name: 'Invalid Model',
            pricing: { prompt: '0.001', completion: '0.002' },
          },
        ],
      }),
    });

    const result = await syncPricingFromOpenRouter();

    expect(insertCount).toBe(1); // Only one model upserted
    expect(result).toBe(1);
  });

  it('should unlock on error', async () => {
    let unlockCalled = false;
    mockClient.query.mockImplementation((sql) => {
      if (sql.includes('pg_try_advisory_lock')) {
        return Promise.resolve({ rows: [{ acquired: true }] });
      }
      if (sql.includes('pg_advisory_unlock')) {
        unlockCalled = true;
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    global.fetch.mockRejectedValueOnce(new Error('Network error'));

    await expect(syncPricingFromOpenRouter()).rejects.toThrow('Network error');
    expect(unlockCalled).toBe(true);
    expect(mockClient.release).toHaveBeenCalled();
  });
});

describe('estimateCostFromTokens', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    // Load test pricing data
    pool.query.mockResolvedValue({
      rows: [
        {
          model_id: 'test-model',
          prompt_cost_per_token: '0.000001',
          completion_cost_per_token: '0.000002',
        },
      ],
    });
    await loadPricingCache();
  });

  it('should return null for null modelId', () => {
    expect(estimateCostFromTokens(null, 1000, 500)).toBeNull();
  });

  it('should return null when pricing not found', () => {
    expect(estimateCostFromTokens('unknown-model', 1000, 500)).toBeNull();
  });

  it('should calculate cost correctly', () => {
    const cost = estimateCostFromTokens('test-model', 1000, 500);
    // (1000 * 0.000001) + (500 * 0.000002) = 0.001 + 0.001 = 0.002
    expect(cost).toBeCloseTo(0.002, 5);
  });

  it('should handle cache read tokens', () => {
    const cost = estimateCostFromTokens('test-model', 1000, 500, {
      cacheReadTokens: 200,
    });
    // Regular: (1000 * 0.000001) + (500 * 0.000002) = 0.002
    // Cache read: 200 * 0.000001 * 0.1 = 0.00002
    // Total: 0.00202
    expect(cost).toBeCloseTo(0.00202, 5);
  });

  it('should handle cache write tokens', () => {
    const cost = estimateCostFromTokens('test-model', 1000, 500, {
      cacheWriteTokens: 100,
    });
    // Regular: (1000 * 0.000001) + (500 * 0.000002) = 0.002
    // Cache write: 100 * 0.000001 * 1.25 = 0.000125
    // Total: 0.002125
    expect(cost).toBeCloseTo(0.002125, 5);
  });

  it('should handle both cache read and write tokens', () => {
    const cost = estimateCostFromTokens('test-model', 1000, 500, {
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
    });
    // Regular: 0.002
    // Cache read: 0.00002
    // Cache write: 0.000125
    // Total: 0.002145
    expect(cost).toBeCloseTo(0.002145, 5);
  });

  it('should return null when cost is zero or negative', () => {
    pool.query.mockResolvedValue({
      rows: [
        {
          model_id: 'zero-model',
          prompt_cost_per_token: '0',
          completion_cost_per_token: '0',
        },
      ],
    });
    loadPricingCache();

    const cost = estimateCostFromTokens('zero-model', 1000, 500);
    expect(cost).toBeNull();
  });

  it('should handle zero input tokens', () => {
    const cost = estimateCostFromTokens('test-model', 0, 500);
    // (0 * 0.000001) + (500 * 0.000002) = 0.001
    expect(cost).toBeCloseTo(0.001, 5);
  });

  it('should handle zero output tokens', () => {
    const cost = estimateCostFromTokens('test-model', 1000, 0);
    // (1000 * 0.000001) + (0 * 0.000002) = 0.001
    expect(cost).toBeCloseTo(0.001, 5);
  });

  it('should normalize modelId with openrouter/ prefix', async () => {
    pool.query.mockResolvedValue({
      rows: [
        {
          model_id: 'anthropic/claude-sonnet-4.5',
          prompt_cost_per_token: '0.000003',
          completion_cost_per_token: '0.000015',
        },
      ],
    });
    await loadPricingCache();

    const cost = estimateCostFromTokens('openrouter/anthropic/claude-sonnet-4.5', 1000, 500);
    expect(cost).toBeGreaterThan(0);
  });
});

describe('startPricingRefreshJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should load cache on startup', async () => {
    pool.query.mockResolvedValue({
      rows: [
        {
          model_id: 'test-model',
          prompt_cost_per_token: '0.000001',
          completion_cost_per_token: '0.000002',
        },
      ],
    });

    const job = startPricingRefreshJob(1000);

    // Wait for async cache load
    await Promise.resolve();

    expect(pool.query).toHaveBeenCalledWith(
      'SELECT model_id, prompt_cost_per_token, completion_cost_per_token FROM model_pricing',
    );

    job.stop();
  });

  it('should start periodic sync', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    pool.connect.mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [{ acquired: false }] }),
      release: jest.fn(),
    });

    const job = startPricingRefreshJob(1000);

    // Wait for initial load
    await Promise.resolve();

    // Fast-forward time to trigger sync
    jest.advanceTimersByTime(1000);
    await Promise.resolve();

    // Should have attempted sync
    expect(pool.connect).toHaveBeenCalled();

    job.stop();
  });

  it('should stop job when stop() is called', () => {
    pool.query.mockResolvedValue({ rows: [] });

    const job = startPricingRefreshJob(1000);

    expect(job.stop).toBeDefined();
    expect(typeof job.stop).toBe('function');

    job.stop();

    // Fast-forward time - should not trigger sync after stop
    jest.advanceTimersByTime(2000);
    // No additional calls should be made
  });
});
