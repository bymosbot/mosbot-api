/**
 * Comprehensive tests for openclawGatewayClient.js
 *
 * Tests:
 * - getDeviceAuthConfig()
 * - buildDeviceConnectPayload()
 * - isRetryableError()
 * - makeOpenClawGatewayRequest() with retry logic
 * - invokeTool()
 * - sessionsList()
 * - sessionsHistory()
 * - cronList()
 * - parseJsonWithLiteralNewlines()
 * - warnIfDeviceAuthNotConfigured()
 */

// Mock fetch globally before requiring modules - this ensures NO actual network calls
global.fetch = jest.fn();

// Store original setTimeout for tests that need real timers
const originalSetTimeout = global.setTimeout;

// Mock WebSocket
const mockWebSocket = {
  send: jest.fn(),
  close: jest.fn(),
  on: jest.fn(),
  readyState: 0,
};
let wsHandlers = {};
jest.mock('ws', () => {
  return jest.fn().mockImplementation(() => mockWebSocket);
});

// Mock config module
const mockConfig = {
  openclaw: {
    gatewayUrl: null,
    gatewayToken: null,
    gatewayTimeoutMs: 2000, // Reduced from 15000ms to 2000ms for faster tests
    device: {
      id: null,
      publicKey: null,
      privateKey: null,
      token: null,
    },
  },
};
jest.mock('../../config', () => mockConfig);

// Mock logger
jest.mock('../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Mock openclawWorkspaceClient for cronList fallback
jest.mock('../openclawWorkspaceClient', () => ({
  getFileContent: jest.fn(),
}));

const logger = require('../../utils/logger');
const { getFileContent } = require('../openclawWorkspaceClient');

// Import the module
const openclawGatewayClient = require('../openclawGatewayClient');
const {
  getDeviceAuthConfig,
  buildDeviceConnectPayload,
  isRetryableError,
  makeOpenClawGatewayRequest,
  invokeTool,
  sessionsList,
  sessionsListAllViaWs,
  sessionsHistory,
  sessionsHistoryViaWs,
  cronList,
  parseJsonWithLiteralNewlines,
  warnIfDeviceAuthNotConfigured,
  sleep,
} = openclawGatewayClient;

function emitWs(event, ...args) {
  const handler = wsHandlers[event];
  if (handler) {
    handler(...args);
  }
}

describe('openclawGatewayClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Use modern fake timers for better async support
    jest.useFakeTimers({ legacyFakeTimers: false });

    // Reset config defaults
    mockConfig.openclaw.gatewayUrl = 'http://test-gateway:18789';
    mockConfig.openclaw.gatewayToken = null;
    mockConfig.openclaw.gatewayTimeoutMs = 15000;
    mockConfig.openclaw.device.id = null;
    mockConfig.openclaw.device.publicKey = null;
    mockConfig.openclaw.device.privateKey = null;
    mockConfig.openclaw.device.token = null;

    // Reset WebSocket mock
    mockWebSocket.send.mockClear();
    mockWebSocket.close.mockClear();
    mockWebSocket.on.mockClear();
    mockWebSocket.readyState = 0;
    wsHandlers = {};
    mockWebSocket.on.mockImplementation((event, handler) => {
      wsHandlers[event] = handler;
    });

    // Reset fetch - ensure NO actual network calls
    global.fetch.mockReset();

    // Reset workspace client
    getFileContent.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('getDeviceAuthConfig()', () => {
    it('should return null when device auth is not configured', () => {
      expect(getDeviceAuthConfig()).toBeNull();
    });

    it('should return null when deviceId is missing', () => {
      mockConfig.openclaw.device.publicKey = 'test-public-key';
      mockConfig.openclaw.device.privateKey = 'fake_private_key_for_testing';
      mockConfig.openclaw.device.token = 'test-token';
      expect(getDeviceAuthConfig()).toBeNull();
    });

    it('should return null when publicKey is missing', () => {
      mockConfig.openclaw.device.id = 'test-device-id';
      mockConfig.openclaw.device.privateKey = 'fake_private_key_for_testing';
      mockConfig.openclaw.device.token = 'test-token';
      expect(getDeviceAuthConfig()).toBeNull();
    });

    it('should return null when privateKey is missing', () => {
      mockConfig.openclaw.device.id = 'test-device-id';
      mockConfig.openclaw.device.publicKey = 'test-public-key';
      mockConfig.openclaw.device.token = 'test-token';
      expect(getDeviceAuthConfig()).toBeNull();
    });

    it('should return null when token is missing', () => {
      mockConfig.openclaw.device.id = 'test-device-id';
      mockConfig.openclaw.device.publicKey = 'test-public-key';
      mockConfig.openclaw.device.privateKey = 'fake_private_key_for_testing';
      expect(getDeviceAuthConfig()).toBeNull();
    });

    it('should return device auth config when all fields are present', () => {
      const crypto = require('crypto');
      const keyPair = crypto.generateKeyPairSync('ed25519');
      const privateKeyDer = keyPair.privateKey.export({ format: 'der', type: 'pkcs8' });
      const privateKeyBytes = privateKeyDer.slice(16);
      const privateKeyB64 = privateKeyBytes.toString('base64url');
      const publicKeyDer = keyPair.publicKey.export({ format: 'der', type: 'spki' });
      const publicKeyBytes = publicKeyDer.slice(12);
      const publicKeyB64 = publicKeyBytes.toString('base64url');

      mockConfig.openclaw.device.id = 'test-device-id';
      mockConfig.openclaw.device.publicKey = publicKeyB64;
      mockConfig.openclaw.device.privateKey = privateKeyB64; // gitleaks:allow // fake private key for tests
      mockConfig.openclaw.device.token = 'test-token';

      const config = getDeviceAuthConfig();
      expect(config).not.toBeNull();
      expect(config.deviceId).toBe('test-device-id');
      expect(config.publicKey).toBe(publicKeyB64);
      expect(config.deviceToken).toBe('test-token');
      expect(config.privateKey).toBeDefined();
    });
  });

  describe('buildDeviceConnectPayload()', () => {
    it('should build a valid connect payload with signature', () => {
      const crypto = require('crypto');
      const keyPair = crypto.generateKeyPairSync('ed25519');
      const privateKeyDer = keyPair.privateKey.export({ format: 'der', type: 'pkcs8' });
      const privateKeyBytes = privateKeyDer.slice(16);
      const _privateKeyB64 = privateKeyBytes.toString('base64url');
      const publicKeyDer = keyPair.publicKey.export({ format: 'der', type: 'spki' });
      const publicKeyBytes = publicKeyDer.slice(12);
      const publicKeyB64 = publicKeyBytes.toString('base64url');

      const deviceAuth = {
        deviceId: 'test-device-id',
        publicKey: publicKeyB64,
        privateKey: keyPair.privateKey,
        deviceToken: 'test-token',
      };

      const nonce = 'test-nonce';
      const payload = buildDeviceConnectPayload(deviceAuth, nonce);

      expect(payload).toMatchObject({
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: 'openclaw-control-ui',
          version: 'server',
          platform: 'node',
          mode: 'webchat',
        },
        role: 'operator',
        scopes: [
          'operator.admin',
          'operator.approvals',
          'operator.pairing',
          'operator.read',
          'operator.write',
        ],
        device: {
          id: 'test-device-id',
          publicKey: publicKeyB64,
          signedAt: expect.any(Number),
          nonce: 'test-nonce',
        },
        auth: { token: 'test-token' },
      });

      expect(payload.device.signature).toBeDefined();
      expect(typeof payload.device.signature).toBe('string');
    });
  });

  describe('isRetryableError()', () => {
    it('should return true for AbortError', () => {
      const error = { name: 'AbortError' };
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for TimeoutError', () => {
      const error = { name: 'TimeoutError' };
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for fetch failed errors', () => {
      const error = { message: 'fetch failed' };
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for ECONNREFUSED', () => {
      const error = { code: 'ECONNREFUSED' };
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for ENOTFOUND', () => {
      const error = { code: 'ENOTFOUND' };
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for 503 without SERVICE_NOT_CONFIGURED code', () => {
      const error = { status: 503, code: 'SERVICE_UNAVAILABLE' };
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return false for 503 with SERVICE_NOT_CONFIGURED code', () => {
      const error = { status: 503, code: 'SERVICE_NOT_CONFIGURED' };
      expect(isRetryableError(error)).toBe(false);
    });

    it('should return false for non-retryable errors', () => {
      const error = { status: 400, code: 'BAD_REQUEST' };
      expect(isRetryableError(error)).toBe(false);
    });
  });

  describe('makeOpenClawGatewayRequest()', () => {
    beforeEach(() => {
      // Use real timers for retry tests to avoid async/timer conflicts
      jest.useRealTimers();
    });

    afterEach(() => {
      // Restore fake timers after retry tests
      jest.useFakeTimers({ legacyFakeTimers: false });
    });

    it('should throw SERVICE_NOT_CONFIGURED when gatewayUrl is not set', async () => {
      mockConfig.openclaw.gatewayUrl = null;

      await expect(makeOpenClawGatewayRequest('/test')).rejects.toMatchObject({
        status: 503,
        code: 'SERVICE_NOT_CONFIGURED',
      });
    });

    it('should throw SERVICE_NOT_CONFIGURED when gatewayUrl is empty string', async () => {
      mockConfig.openclaw.gatewayUrl = '';

      await expect(makeOpenClawGatewayRequest('/test')).rejects.toMatchObject({
        status: 503,
        code: 'SERVICE_NOT_CONFIGURED',
      });
    });

    it('should make successful POST request without body', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const result = await makeOpenClawGatewayRequest('/test');

      expect(result).toEqual({ success: true });
      expect(global.fetch).toHaveBeenCalledWith(
        'http://test-gateway:18789/test',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      );
    });

    it('should make successful POST request with body', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const result = await makeOpenClawGatewayRequest('/test', { key: 'value' });

      expect(result).toEqual({ success: true });
      expect(global.fetch).toHaveBeenCalledWith(
        'http://test-gateway:18789/test',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ key: 'value' }),
        }),
      );
    });

    it('should include Authorization header when gatewayToken is set', async () => {
      mockConfig.openclaw.gatewayToken = 'test-token';
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await makeOpenClawGatewayRequest('/test');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://test-gateway:18789/test',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        }),
      );
    });

    it('should retry on 503 errors with exponential backoff', async () => {
      global.fetch
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: async () => 'Service Unavailable',
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true }),
        });

      const result = await makeOpenClawGatewayRequest('/test');

      expect(result).toEqual({ success: true });
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        'OpenClaw gateway request failed, retrying',
        expect.objectContaining({
          retryCount: 1,
        }),
      );
    });

    it('should retry on AbortError with exponential backoff', async () => {
      const abortError = new Error('Request aborted');
      abortError.name = 'AbortError';

      global.fetch.mockRejectedValueOnce(abortError).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const result = await makeOpenClawGatewayRequest('/test');

      expect(result).toEqual({ success: true });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should stop retrying after maxRetries', async () => {
      const abortError = new Error('Request aborted');
      abortError.name = 'AbortError';

      global.fetch.mockRejectedValue(abortError);

      await expect(makeOpenClawGatewayRequest('/test')).rejects.toMatchObject({
        status: 503,
        code: 'SERVICE_TIMEOUT',
      });

      // In test environment, maxRetries is 1, so expect initial + 1 retry = 2 calls
      expect(global.fetch).toHaveBeenCalledTimes(2); // Initial + 1 retry (was 4 in prod)
    });

    it('should throw SERVICE_TIMEOUT after retries exhausted for timeout errors', async () => {
      const timeoutError = new Error('Timeout');
      timeoutError.name = 'TimeoutError';

      global.fetch.mockRejectedValue(timeoutError);

      await expect(makeOpenClawGatewayRequest('/test')).rejects.toMatchObject({
        status: 503,
        code: 'SERVICE_TIMEOUT',
      });
    });

    it('should throw SERVICE_UNAVAILABLE after retries exhausted for connection errors', async () => {
      const connError = new Error('fetch failed');
      connError.code = 'ECONNREFUSED';

      global.fetch.mockRejectedValue(connError);

      await expect(makeOpenClawGatewayRequest('/test')).rejects.toMatchObject({
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
      });
    }, 4000); // Reduced from 15000ms to 4000ms (still allows for retries but shorter)

    it('should throw error with status code for non-retryable errors', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad Request',
      });

      await expect(makeOpenClawGatewayRequest('/test')).rejects.toMatchObject({
        status: 400,
        code: 'OPENCLAW_GATEWAY_ERROR',
      });
    });

    it('should re-throw errors that already have status code', async () => {
      const error = new Error('Custom error');
      error.status = 401;

      global.fetch.mockRejectedValue(error);

      await expect(makeOpenClawGatewayRequest('/test')).rejects.toMatchObject({
        status: 401,
      });

      expect(logger.debug).toHaveBeenCalledWith(
        'OpenClaw gateway request failed',
        expect.objectContaining({
          status: 401,
        }),
      );
    });

    it('should throw SERVICE_ERROR for generic errors', async () => {
      global.fetch.mockRejectedValueOnce(new Error('Generic error'));

      await expect(makeOpenClawGatewayRequest('/test')).rejects.toMatchObject({
        status: 503,
        code: 'SERVICE_ERROR',
      });
    });
  });

  describe('invokeTool()', () => {
    it('should invoke tool with default options', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { data: 'test' },
        }),
      });

      const result = await invokeTool('test_tool', { arg: 'value' });

      expect(result).toEqual({ data: 'test' });
      expect(global.fetch).toHaveBeenCalledWith(
        'http://test-gateway:18789/tools/invoke',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            tool: 'test_tool',
            action: 'json',
            args: { arg: 'value' },
            sessionKey: 'main',
            dryRun: false,
          }),
        }),
      );
    });

    it('should invoke tool with custom options', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { data: 'test' },
        }),
      });

      await invokeTool(
        'test_tool',
        { arg: 'value' },
        {
          sessionKey: 'custom-session',
          action: 'text',
          dryRun: true,
        },
      );

      expect(global.fetch).toHaveBeenCalledWith(
        'http://test-gateway:18789/tools/invoke',
        expect.objectContaining({
          body: JSON.stringify({
            tool: 'test_tool',
            action: 'text',
            args: { arg: 'value' },
            sessionKey: 'custom-session',
            dryRun: true,
          }),
        }),
      );
    });

    it('should return null for 404 errors', async () => {
      const error = new Error('Not found');
      error.status = 404;
      global.fetch.mockRejectedValueOnce(error);

      const result = await invokeTool('nonexistent_tool');

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Tool not available', expect.any(Object));
    });

    it('should return null for 401 errors', async () => {
      const error = new Error('Unauthorized');
      error.status = 401;
      global.fetch.mockRejectedValueOnce(error);

      const result = await invokeTool('test_tool');

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'OpenClaw gateway auth failed for tool invocation',
        expect.any(Object),
      );
    });

    it('should throw error when response.ok is false', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: false,
          error: { message: 'Tool failed' },
        }),
      });

      await expect(invokeTool('test_tool')).rejects.toMatchObject({
        status: 400,
        code: 'TOOL_INVOCATION_ERROR',
      });
    });

    it('should return result when response.ok is true', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { success: true },
        }),
      });

      const result = await invokeTool('test_tool');

      expect(result).toEqual({ success: true });
    });

    it('should return full response when result is not present', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: 'test',
        }),
      });

      const result = await invokeTool('test_tool');

      expect(result).toEqual({ ok: true, data: 'test' });
    });
  });

  describe('sessionsList()', () => {
    it('should return empty array when result is null', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: null,
        }),
      });

      const result = await sessionsList();

      expect(result).toEqual([]);
    });

    it('should return direct array response', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: [{ id: '1' }, { id: '2' }],
        }),
      });

      const result = await sessionsList();

      expect(result).toEqual([{ id: '1' }, { id: '2' }]);
    });

    it('should extract sessions from details.sessions', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: {
            details: { sessions: [{ id: '1' }, { id: '2' }] },
          },
        }),
      });

      const result = await sessionsList();

      expect(result).toEqual([{ id: '1' }, { id: '2' }]);
    });

    it('should extract sessions from rows', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: {
            rows: [{ id: '1' }, { id: '2' }],
          },
        }),
      });

      const result = await sessionsList();

      expect(result).toEqual([{ id: '1' }, { id: '2' }]);
    });

    it('should extract sessions from sessions', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: {
            sessions: [{ id: '1' }, { id: '2' }],
          },
        }),
      });

      const result = await sessionsList();

      expect(result).toEqual([{ id: '1' }, { id: '2' }]);
    });

    it('should return empty array for unexpected structure', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { unexpected: 'structure' },
        }),
      });

      const result = await sessionsList();

      expect(result).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'Unexpected sessions_list result structure',
        expect.any(Object),
      );
    });

    it('should pass parameters to invokeTool', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: [],
        }),
      });

      await sessionsList({
        sessionKey: 'custom',
        kinds: ['main', 'cron'],
        limit: 10,
        activeMinutes: 5,
        messageLimit: 20,
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://test-gateway:18789/tools/invoke',
        expect.objectContaining({
          body: JSON.stringify({
            tool: 'sessions_list',
            action: 'json',
            args: {
              kinds: ['main', 'cron'],
              limit: 10,
              activeMinutes: 5,
              messageLimit: 20,
            },
            sessionKey: 'custom',
            dryRun: false,
          }),
        }),
      );
    });

    it('should return empty array for SERVICE_NOT_CONFIGURED', async () => {
      // makeOpenClawGatewayRequest throws SERVICE_NOT_CONFIGURED when gatewayUrl is not set
      mockConfig.openclaw.gatewayUrl = null;

      const result = await sessionsList();

      expect(result).toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should return empty array for SERVICE_UNAVAILABLE', async () => {
      // Test error handling - verify that sessionsList handles SERVICE_UNAVAILABLE errors gracefully
      // Note: Retry logic is tested in makeOpenClawGatewayRequest tests.
      // This test goes through the full retry flow (3 retries with delays ~3.5s total)
      const connError = { message: 'fetch failed', code: 'ECONNREFUSED' };
      global.fetch.mockRejectedValue(connError);

      // Use real timers - retries will take ~3.5s (500ms + 1000ms + 2000ms)
      jest.useRealTimers();
      const result = await sessionsList();
      jest.useFakeTimers({ legacyFakeTimers: false });

      expect(result).toEqual([]);
    }, 4000); // Reduced from 10000ms to 4000ms (still allows for retries but shorter)

    it('should throw other errors', async () => {
      const error = new Error('Other error');
      error.code = 'OTHER_ERROR';
      global.fetch.mockRejectedValueOnce(error);

      await expect(sessionsList()).rejects.toThrow('Other error');
    });
  });

  describe('sessionsHistory()', () => {
    it('should throw error when sessionKey is missing', async () => {
      await expect(sessionsHistory()).rejects.toThrow('sessionKey is required');
    });

    it('should fetch history with sessionKey', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: {
            messages: [{ id: '1' }, { id: '2' }],
          },
        }),
      });

      const result = await sessionsHistory({ sessionKey: 'test-session' });

      expect(result).toEqual([{ id: '1' }, { id: '2' }]);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://test-gateway:18789/tools/invoke',
        expect.objectContaining({
          body: JSON.stringify({
            tool: 'sessions_history',
            action: 'json',
            args: { sessionKey: 'test-session' },
            sessionKey: 'test-session',
            dryRun: false,
          }),
        }),
      );
    });

    it('should pass limit and includeTools to invokeTool', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { messages: [] },
        }),
      });

      await sessionsHistory({
        sessionKey: 'test-session',
        limit: 100,
        includeTools: true,
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://test-gateway:18789/tools/invoke',
        expect.objectContaining({
          body: JSON.stringify({
            tool: 'sessions_history',
            action: 'json',
            args: {
              sessionKey: 'test-session',
              limit: 100,
              includeTools: true,
            },
            sessionKey: 'test-session',
            dryRun: false,
          }),
        }),
      );
    });

    it('should use parent agent context for subagent sessions', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { messages: [] },
        }),
      });

      await sessionsHistory({ sessionKey: 'agent:coo:subagent:uuid' });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://test-gateway:18789/tools/invoke',
        expect.objectContaining({
          body: JSON.stringify({
            tool: 'sessions_history',
            action: 'json',
            args: { sessionKey: 'agent:coo:subagent:uuid' },
            sessionKey: 'agent:coo:main',
            dryRun: false,
          }),
        }),
      );
    });

    it('should return direct array response', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: [{ id: '1' }, { id: '2' }],
        }),
      });

      const result = await sessionsHistory({ sessionKey: 'test' });

      expect(result).toEqual([{ id: '1' }, { id: '2' }]);
    });

    it('should return empty array when result is null', async () => {
      // invokeTool returns null for 404/401, which sessionsHistory converts to []
      global.fetch.mockRejectedValueOnce({
        status: 404,
        message: 'Not found',
      });

      const result = await sessionsHistory({ sessionKey: 'test' });

      expect(result).toEqual([]);
    });

    it('should warn when empty result is returned', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { messages: [] },
        }),
      });

      await sessionsHistory({ sessionKey: 'test' });

      expect(logger.warn).toHaveBeenCalledWith(
        'sessions_history returned empty messages',
        expect.any(Object),
      );
    });

    it('should return empty array for SERVICE_NOT_CONFIGURED', async () => {
      // makeOpenClawGatewayRequest throws SERVICE_NOT_CONFIGURED when gatewayUrl is not set
      mockConfig.openclaw.gatewayUrl = null;

      const result = await sessionsHistory({ sessionKey: 'test' });

      expect(result).toEqual([]);
    });

    it('should return empty array for SERVICE_UNAVAILABLE', async () => {
      // Test error handling - verify that sessionsHistory handles SERVICE_UNAVAILABLE errors gracefully
      // Note: Retry logic is tested in makeOpenClawGatewayRequest tests.
      // This test goes through the full retry flow (3 retries with delays ~3.5s total)
      const connError = { message: 'fetch failed', code: 'ECONNREFUSED' };
      global.fetch.mockRejectedValue(connError);

      // Use real timers - retries will take ~3.5s (500ms + 1000ms + 2000ms)
      jest.useRealTimers();
      const result = await sessionsHistory({ sessionKey: 'test' });
      jest.useFakeTimers({ legacyFakeTimers: false });

      expect(result).toEqual([]);
    }, 4000); // Reduced from 10000ms to 4000ms (still allows for retries but shorter)

    it('should throw other errors', async () => {
      const error = new Error('Other error');
      global.fetch.mockRejectedValueOnce(error);

      await expect(sessionsHistory({ sessionKey: 'test' })).rejects.toThrow('Other error');
    });
  });

  describe('cronList()', () => {
    it('should return jobs from cron.list tool', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: {
            jobs: [{ id: '1' }, { id: '2' }],
          },
        }),
      });

      const result = await cronList();

      expect(result).toEqual([{ id: '1' }, { id: '2' }]);
      expect(logger.info).toHaveBeenCalledWith(
        'cron.list returned jobs via /tools/invoke',
        expect.objectContaining({ count: 2 }),
      );
    });

    it('should return empty array when cron.list returns empty', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { jobs: [] },
        }),
      });

      const result = await cronList();

      expect(result).toEqual([]);
    });

    it('should fallback to jobs.json when cron.list fails', async () => {
      const error = new Error('Tool failed');
      global.fetch.mockRejectedValueOnce(error);
      getFileContent.mockResolvedValueOnce(
        JSON.stringify({ jobs: { job1: { id: '1' }, job2: { id: '2' } } }),
      );

      const result = await cronList();

      expect(result).toEqual([{ id: '1' }, { id: '2' }]);
      expect(getFileContent).toHaveBeenCalledWith('/cron/jobs.json');
      expect(logger.warn).toHaveBeenCalledWith(
        'cron.list tool invocation failed, trying jobs.json fallback',
        expect.any(Object),
      );
    });

    it('should return empty array when SERVICE_NOT_CONFIGURED', async () => {
      const error = new Error('Not configured');
      error.code = 'SERVICE_NOT_CONFIGURED';
      global.fetch.mockRejectedValueOnce(error);

      const result = await cronList();

      expect(result).toEqual([]);
    });

    it('should return empty array when SERVICE_UNAVAILABLE', async () => {
      const error = new Error('Unavailable');
      error.code = 'SERVICE_UNAVAILABLE';
      global.fetch.mockRejectedValueOnce(error);

      const result = await cronList();

      expect(result).toEqual([]);
    });

    it('should return empty array when both methods fail', async () => {
      global.fetch.mockRejectedValueOnce(new Error('Tool failed'));
      getFileContent.mockRejectedValueOnce(new Error('File not found'));

      const result = await cronList();

      expect(result).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'jobs.json fallback also failed',
        expect.any(Object),
      );
    });

    it('should handle single-job object from cron.list tool', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { jobId: 'job-1', name: 'Daily summary' },
        }),
      });

      const result = await cronList();

      expect(result).toEqual([{ jobId: 'job-1', name: 'Daily summary' }]);
    });

    it('should handle jobs.json with array format', async () => {
      global.fetch.mockRejectedValueOnce(new Error('Tool failed'));
      getFileContent.mockResolvedValueOnce(JSON.stringify([{ id: '1' }, { id: '2' }]));

      const result = await cronList();

      expect(result).toEqual([{ id: '1' }, { id: '2' }]);
    });

    it('should handle jobs.json with object map format', async () => {
      global.fetch.mockRejectedValueOnce(new Error('Tool failed'));
      getFileContent.mockResolvedValueOnce(
        JSON.stringify({ jobs: { job1: { id: '1' }, job2: { id: '2' } } }),
      );

      const result = await cronList();

      expect(result).toEqual([{ id: '1' }, { id: '2' }]);
    });
  });

  describe('parseJsonWithLiteralNewlines()', () => {
    it('should parse valid JSON', () => {
      const json = '{"key": "value"}';
      expect(parseJsonWithLiteralNewlines(json)).toEqual({ key: 'value' });
    });

    it('should parse JSON with literal newlines in markdown code blocks', () => {
      const json = `{
  "payload": "Here is some code:
\`\`\`json
{
  "nested": "value"
}
\`\`\`
"
}`;
      const result = parseJsonWithLiteralNewlines(json);
      expect(result.payload).toContain('```json');
      // After parsing, newlines are actual newlines, not escaped
      expect(result.payload).toContain('\n');
    });

    it('should parse JSON with literal newlines in string values', () => {
      const json = `{"message": "Line 1
Line 2"}`;
      const result = parseJsonWithLiteralNewlines(json);
      // The function escapes newlines during parsing, then parses JSON
      // So the result contains actual newlines
      expect(result.message).toContain('Line 1');
      expect(result.message).toContain('Line 2');
      // Newlines are actual newlines after parsing
      expect(result.message).toMatch(/Line 1[\n]Line 2/);
    });

    it('should handle carriage returns', () => {
      const json = '{"message": "Line 1\rLine 2"}';
      const result = parseJsonWithLiteralNewlines(json);
      // The function escapes carriage returns
      expect(result.message).toContain('Line 1');
      expect(result.message).toContain('Line 2');
    });

    it('should handle unescaped quotes in code blocks', () => {
      const json = `{
  "code": "
\`\`\`json
{
  "key": "value with \\"quotes\\""
}
\`\`\`
"
}`;
      const result = parseJsonWithLiteralNewlines(json);
      expect(result.code).toBeDefined();
    });

    it('should throw error for completely invalid JSON', () => {
      const json = 'not json at all';
      expect(() => parseJsonWithLiteralNewlines(json)).toThrow();
    });
  });

  describe('warnIfDeviceAuthNotConfigured()', () => {
    it('should not warn when gatewayUrl is not set', () => {
      mockConfig.openclaw.gatewayUrl = null;
      warnIfDeviceAuthNotConfigured();
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('should warn when device auth vars are missing', () => {
      mockConfig.openclaw.gatewayUrl = 'http://test';
      mockConfig.openclaw.device.id = null;
      warnIfDeviceAuthNotConfigured();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('OpenClaw device auth not configured'),
        expect.objectContaining({
          missingVars: expect.arrayContaining(['OPENCLAW_DEVICE_ID']),
        }),
      );
    });

    it('should log info when device auth is configured', () => {
      mockConfig.openclaw.gatewayUrl = 'http://test';
      mockConfig.openclaw.device.id = 'test-device';
      mockConfig.openclaw.device.publicKey = 'test-public';
      mockConfig.openclaw.device.privateKey = 'test-private';
      mockConfig.openclaw.device.token = 'test-token';
      warnIfDeviceAuthNotConfigured();
      expect(logger.info).toHaveBeenCalledWith(
        'OpenClaw device auth configured',
        expect.objectContaining({
          deviceId: 'test-device',
        }),
      );
    });
  });

  describe('sleep()', () => {
    it('should resolve after specified milliseconds', async () => {
      const promise = sleep(1000);
      jest.advanceTimersByTime(1000);
      await expect(promise).resolves.toBeUndefined();
    });
  });

  describe('WebSocket RPC flows', () => {
    it('should call sessions.list via allowInsecureAuth flow', async () => {
      jest.useRealTimers(); // Use real timers for WebSocket tests
      const sessionsPayload = { sessions: [{ id: 's1' }] };
      mockConfig.openclaw.device.id = null;

      mockWebSocket.send.mockImplementation((payload) => {
        const message = JSON.parse(payload);
        if (message.method === 'connect') {
          originalSetTimeout(() => {
            emitWs(
              'message',
              JSON.stringify({ type: 'res', id: message.id, ok: true, payload: {} }),
            );
          }, 0);
          return;
        }
        if (message.method === 'sessions.list') {
          originalSetTimeout(() => {
            emitWs(
              'message',
              JSON.stringify({
                type: 'res',
                id: message.id,
                ok: true,
                payload: sessionsPayload,
              }),
            );
          }, 0);
        }
      });

      const promise = sessionsListAllViaWs({
        includeGlobal: true,
        includeUnknown: false,
        activeMinutes: 10,
        limit: 20,
        messageLimit: 5,
      });

      emitWs('open');
      await expect(promise).resolves.toEqual(sessionsPayload);
      expect(mockWebSocket.close).toHaveBeenCalled();
    });

    it('should call chat.history via device-auth challenge flow', async () => {
      jest.useRealTimers(); // Use real timers for WebSocket tests
      const crypto = require('crypto');
      const keyPair = crypto.generateKeyPairSync('ed25519');
      const privateKeyDer = keyPair.privateKey.export({ format: 'der', type: 'pkcs8' });
      const privateKeyBytes = privateKeyDer.slice(16);
      const privateKeyB64 = privateKeyBytes.toString('base64url');
      const publicKeyDer = keyPair.publicKey.export({ format: 'der', type: 'spki' });
      const publicKeyBytes = publicKeyDer.slice(12);
      const publicKeyB64 = publicKeyBytes.toString('base64url');

      mockConfig.openclaw.device.id = 'device-1';
      mockConfig.openclaw.device.publicKey = publicKeyB64;
      mockConfig.openclaw.device.privateKey = privateKeyB64; // gitleaks:allow // fake private key for tests
      mockConfig.openclaw.device.token = 'device-token';

      mockWebSocket.send.mockImplementation((payload) => {
        const message = JSON.parse(payload);
        if (message.method === 'connect') {
          originalSetTimeout(() => {
            emitWs(
              'message',
              JSON.stringify({ type: 'res', id: message.id, ok: true, payload: {} }),
            );
          }, 0);
          return;
        }
        if (message.method === 'chat.history') {
          originalSetTimeout(() => {
            emitWs(
              'message',
              JSON.stringify({
                type: 'res',
                id: message.id,
                ok: true,
                payload: { messages: [{ id: 'm1' }] },
              }),
            );
          }, 0);
        }
      });

      const promise = sessionsHistoryViaWs({ sessionKey: 'agent:coo:subagent:uuid', limit: 50 });
      emitWs('open');
      emitWs(
        'message',
        JSON.stringify({
          type: 'event',
          event: 'connect.challenge',
          payload: { nonce: 'nonce-123' },
        }),
      );

      await expect(promise).resolves.toEqual({ messages: [{ id: 'm1' }] });
      expect(mockWebSocket.close).toHaveBeenCalled();
    });

    it('should throw when sessionsHistoryViaWs is missing sessionKey', async () => {
      await expect(sessionsHistoryViaWs()).rejects.toThrow('sessionKey is required');
    });

    it('should reject with SERVICE_TIMEOUT when websocket RPC times out', (done) => {
      jest.useRealTimers(); // Use real timers for WebSocket timeout test
      mockConfig.openclaw.gatewayTimeoutMs = 50; // Small timeout for faster test

      sessionsListAllViaWs()
        .then(() => {
          done.fail('Expected promise to be rejected');
        })
        .catch((error) => {
          try {
            expect(error).toMatchObject({
              status: 503,
              code: 'SERVICE_TIMEOUT',
            });
            expect(mockWebSocket.close).toHaveBeenCalled();
            done();
          } catch (assertionError) {
            done.fail(assertionError);
          }
        });

      // The timeout will occur automatically based on the configured gatewayTimeoutMs
    }, 10000);

    it('should reject with SERVICE_UNAVAILABLE on websocket error', async () => {
      jest.useRealTimers(); // Use real timers for WebSocket tests
      const promise = sessionsListAllViaWs();
      emitWs('error', new Error('connection failed'));

      await expect(promise).rejects.toMatchObject({
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
      });
    });

    it('should reject pending requests when websocket closes early', async () => {
      jest.useRealTimers(); // Use real timers for WebSocket tests
      mockWebSocket.send.mockImplementation(() => {
        // Keep connect pending to exercise close handler rejection path.
      });
      const promise = sessionsListAllViaWs();
      emitWs('open');
      emitWs('close', 1006, 'abnormal');

      await expect(promise).rejects.toThrow('WebSocket closed (1006): abnormal');
    });
  });
});
