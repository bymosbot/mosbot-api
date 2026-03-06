const { makeOpenClawRequest } = require('./openclawWorkspaceClient');

describe('openclawWorkspaceClient', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.OPENCLAW_WORKSPACE_URL;
    process.env.NODE_ENV = 'production';
    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env = originalEnv;
    delete global.fetch;
  });

  it('returns SERVICE_NOT_CONFIGURED when OPENCLAW_WORKSPACE_URL is missing (production too)', async () => {
    await expect(makeOpenClawRequest('GET', '/status')).rejects.toMatchObject({
      status: 503,
      code: 'SERVICE_NOT_CONFIGURED',
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('uses OPENCLAW_WORKSPACE_URL when configured', async () => {
    process.env.OPENCLAW_WORKSPACE_URL = 'http://workspace.example:18780';
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok' }),
    });

    const data = await makeOpenClawRequest('GET', '/status');

    expect(data).toEqual({ status: 'ok' });
    expect(global.fetch).toHaveBeenCalledWith(
      'http://workspace.example:18780/status',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
