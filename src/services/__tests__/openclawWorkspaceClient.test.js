global.fetch = jest.fn();

const mockConfig = {
  nodeEnv: 'test',
  openclaw: {
    workspaceUrl: 'http://workspace-service:8080',
    workspaceToken: null,
  },
};

jest.mock('../../config', () => mockConfig);
jest.mock('../../utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const logger = require('../../utils/logger');
const {
  makeOpenClawRequest,
  getFileContent,
  putFileContent,
  isRetryableError,
  sleep,
} = require('../openclawWorkspaceClient');

describe('openclawWorkspaceClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    mockConfig.nodeEnv = 'test';
    mockConfig.openclaw.workspaceUrl = 'http://workspace-service:8080';
    mockConfig.openclaw.workspaceToken = null;
    global.fetch.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('isRetryableError()', () => {
    it('returns true for timeout-style errors', () => {
      expect(isRetryableError({ name: 'AbortError' })).toBe(true);
      expect(isRetryableError({ name: 'TimeoutError' })).toBe(true);
    });

    it('returns true for connection errors and retryable 503', () => {
      expect(isRetryableError({ message: 'fetch failed' })).toBe(true);
      expect(isRetryableError({ message: 'x', code: 'ECONNREFUSED' })).toBe(true);
      expect(isRetryableError({ message: 'x', code: 'ENOTFOUND' })).toBe(true);
      expect(isRetryableError({ message: 'x', status: 503, code: 'ANY' })).toBe(true);
    });

    it('returns false for SERVICE_NOT_CONFIGURED and other non-retryable errors', () => {
      expect(
        isRetryableError({
          message: 'x',
          status: 503,
          code: 'SERVICE_NOT_CONFIGURED',
        }),
      ).toBe(false);
      expect(isRetryableError({ message: 'x', status: 400, code: 'BAD' })).toBe(false);
    });
  });

  describe('makeOpenClawRequest()', () => {
    it('throws SERVICE_NOT_CONFIGURED when URL is missing in non-production', async () => {
      mockConfig.openclaw.workspaceUrl = null;
      await expect(makeOpenClawRequest('GET', '/files')).rejects.toMatchObject({
        status: 503,
        code: 'SERVICE_NOT_CONFIGURED',
      });
    });

    it('includes auth header and body when provided', async () => {
      mockConfig.openclaw.workspaceToken = 'token-123';
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ saved: true }),
      });

      await makeOpenClawRequest('PUT', '/files', { path: '/a.txt', content: 'x' });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://workspace-service:8080/files',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ path: '/a.txt', content: 'x' }),
          headers: expect.objectContaining({
            Authorization: 'Bearer token-123',
            'Content-Type': 'application/json',
          }),
        }),
      );
    });

    it('returns null on 204 response', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: async () => ({}),
      });
      await expect(makeOpenClawRequest('DELETE', '/files/x')).resolves.toBeNull();
    });

    it('retries on 503 then succeeds', async () => {
      global.fetch
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: async () => 'Service Unavailable',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        });

      const result = await makeOpenClawRequest('GET', '/files');
      expect(result).toEqual({ ok: true });
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('throws SERVICE_TIMEOUT after timeout retries exhausted', async () => {
      const timeoutErr = new Error('timeout');
      timeoutErr.name = 'TimeoutError';
      global.fetch.mockRejectedValue(timeoutErr);

      await expect(makeOpenClawRequest('GET', '/files')).rejects.toMatchObject({
        status: 503,
        code: 'SERVICE_TIMEOUT',
      });
    }, 3000); // Reduced from 12000ms to 3000ms

    it('throws SERVICE_UNAVAILABLE after fetch-failed retries exhausted', async () => {
      const connErr = new Error('fetch failed');
      connErr.code = 'ECONNREFUSED';
      global.fetch.mockRejectedValue(connErr);

      await expect(makeOpenClawRequest('GET', '/files')).rejects.toMatchObject({
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
      });
    }, 3000); // Reduced from 12000ms to 3000ms

    it('rethrows 404 status errors and logs debug', async () => {
      const notFound = new Error('missing');
      notFound.status = 404;
      global.fetch.mockRejectedValueOnce(notFound);

      await expect(makeOpenClawRequest('GET', '/files/content')).rejects.toMatchObject({
        status: 404,
      });
      expect(logger.debug).toHaveBeenCalledWith(
        'OpenClaw workspace file not found',
        expect.objectContaining({ status: 404 }),
      );
    });

    it('rethrows non-404 status errors and logs error', async () => {
      const badReq = new Error('bad request');
      badReq.status = 400;
      global.fetch.mockRejectedValueOnce(badReq);

      await expect(makeOpenClawRequest('GET', '/files/content')).rejects.toMatchObject({
        status: 400,
      });
      expect(logger.error).toHaveBeenCalledWith(
        'OpenClaw workspace request failed',
        expect.objectContaining({ status: 400 }),
      );
    });

    it('wraps unknown errors as SERVICE_ERROR', async () => {
      global.fetch.mockRejectedValueOnce(new Error('boom'));

      await expect(makeOpenClawRequest('GET', '/files')).rejects.toMatchObject({
        status: 503,
        code: 'SERVICE_ERROR',
      });
    });
  });

  describe('getFileContent()', () => {
    it('returns content for happy path', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ content: 'abc' }),
      });

      await expect(getFileContent('/runtime/file.txt')).resolves.toBe('abc');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://workspace-service:8080/files/content?path=%2Fruntime%2Ffile.txt',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('returns null when response has no content field', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });

      await expect(getFileContent('/runtime/file.txt')).resolves.toBeNull();
    });

    it('returns null on 404 from service', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      });

      await expect(getFileContent('/runtime/missing.txt')).resolves.toBeNull();
    });

    it('returns null on OPENCLAW_SERVICE_ERROR from service', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'server error',
      });

      await expect(getFileContent('/runtime/maybe.txt')).resolves.toBeNull();
    });
  });

  describe('putFileContent()', () => {
    it('writes with default utf8 encoding', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });

      await putFileContent('/a.txt', 'hello');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://workspace-service:8080/files',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            path: '/a.txt',
            content: 'hello',
            encoding: 'utf8',
          }),
        }),
      );
    });

    it('writes with custom encoding', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });

      await putFileContent('/a.bin', 'AA==', 'base64');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://workspace-service:8080/files',
        expect.objectContaining({
          body: JSON.stringify({
            path: '/a.bin',
            content: 'AA==',
            encoding: 'base64',
          }),
        }),
      );
    });
  });

  describe('sleep()', () => {
    it('resolves after delay', async () => {
      jest.useFakeTimers({ legacyFakeTimers: false });
      const p = sleep(20);
      jest.advanceTimersByTime(20);
      await expect(p).resolves.toBeUndefined();
    });
  });
});
