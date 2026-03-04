jest.mock('../../utils/logger', () => ({
  warn: jest.fn(),
}));

jest.mock('../openclawWorkspaceClient', () => ({
  getWorkspaceLink: jest.fn(),
  ensureWorkspaceLink: jest.fn(),
  getFileContent: jest.fn(),
}));

const logger = require('../../utils/logger');
const {
  getWorkspaceLink,
  ensureWorkspaceLink,
  getFileContent,
} = require('../openclawWorkspaceClient');
const {
  ensureDocsLinkIfMissing,
  reconcileDocsLinksOnStartup,
  collectAgentIdsFromOpenClawConfig,
} = require('../docsLinkReconciliationService');

describe('docsLinkReconciliationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates docs link when state is missing', async () => {
    getWorkspaceLink.mockResolvedValueOnce({ state: 'missing' });
    ensureWorkspaceLink.mockResolvedValueOnce({ action: 'created' });

    const result = await ensureDocsLinkIfMissing('cto');

    expect(result).toEqual({ agentId: 'cto', action: 'created', state: 'linked' });
    expect(getWorkspaceLink).toHaveBeenCalledWith('docs', 'cto');
    expect(ensureWorkspaceLink).toHaveBeenCalledWith('docs', 'cto');
  });

  it('does not write when link is already linked', async () => {
    getWorkspaceLink.mockResolvedValueOnce({ state: 'linked' });

    const result = await ensureDocsLinkIfMissing('cto');

    expect(result).toEqual({ agentId: 'cto', action: 'unchanged', state: 'linked' });
    expect(ensureWorkspaceLink).not.toHaveBeenCalled();
  });

  it('warns and skips writes when state is conflict', async () => {
    getWorkspaceLink.mockResolvedValueOnce({
      state: 'conflict',
      conflict: { reason: 'Path exists and is not a symlink' },
    });

    const result = await ensureDocsLinkIfMissing('cto');

    expect(result).toEqual({ agentId: 'cto', action: 'conflict', state: 'conflict' });
    expect(ensureWorkspaceLink).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Docs link reconciliation found conflict',
      expect.objectContaining({ agentId: 'cto' }),
    );
  });

  it('warns and returns skipped when agentId is missing', async () => {
    const result = await ensureDocsLinkIfMissing(null);
    expect(result).toEqual({ agentId: null, action: 'skipped' });
    expect(getWorkspaceLink).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Docs link reconciliation skipped: missing agentId');
  });

  it('handles unexpected states without writing', async () => {
    getWorkspaceLink.mockResolvedValueOnce({ state: 'mystery' });

    const result = await ensureDocsLinkIfMissing('cto');

    expect(result).toEqual({ agentId: 'cto', action: 'unknown', state: 'mystery' });
    expect(ensureWorkspaceLink).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Docs link reconciliation received unexpected state',
      expect.objectContaining({ agentId: 'cto' }),
    );
  });

  it('returns error action when workspace client fails', async () => {
    getWorkspaceLink.mockRejectedValueOnce(Object.assign(new Error('down'), { status: 503 }));

    const result = await ensureDocsLinkIfMissing('main');

    expect(result).toEqual({ agentId: 'main', action: 'error' });
    expect(ensureWorkspaceLink).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Docs link reconciliation failed',
      expect.objectContaining({ agentId: 'main', status: 503 }),
    );
  });

  it('collectAgentIdsFromOpenClawConfig extracts unique non-main ids', () => {
    const ids = collectAgentIdsFromOpenClawConfig(
      JSON.stringify({
        agents: {
          list: [{ id: 'main' }, { id: 'clawboard-worker' }, { id: 'cto' }, { id: 'cto' }],
        },
      }),
    );

    expect(ids).toEqual(['clawboard-worker', 'cto']);
  });

  it('collectAgentIdsFromOpenClawConfig returns [] on parse errors', () => {
    const ids = collectAgentIdsFromOpenClawConfig('{bad json');
    expect(ids).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Docs link startup reconciliation: could not parse openclaw.json',
      expect.objectContaining({ message: expect.any(String) }),
    );
  });

  it('reconcileDocsLinksOnStartup ensures main and configured agents', async () => {
    getFileContent.mockResolvedValueOnce(
      JSON.stringify({
        agents: {
          list: [{ id: 'main' }, { id: 'clawboard-worker' }, { id: 'cto' }],
        },
      }),
    );
    getWorkspaceLink
      .mockResolvedValueOnce({ state: 'missing' }) // main
      .mockResolvedValueOnce({ state: 'missing' }) // clawboard-worker
      .mockResolvedValueOnce({ state: 'linked' }); // cto
    ensureWorkspaceLink
      .mockResolvedValueOnce({ action: 'created' }) // main
      .mockResolvedValueOnce({ action: 'created' }); // clawboard-worker

    const result = await reconcileDocsLinksOnStartup();

    expect(getWorkspaceLink).toHaveBeenNthCalledWith(1, 'docs', 'main');
    expect(getWorkspaceLink).toHaveBeenNthCalledWith(2, 'docs', 'clawboard-worker');
    expect(getWorkspaceLink).toHaveBeenNthCalledWith(3, 'docs', 'cto');
    expect(result.main).toEqual({ agentId: 'main', action: 'created', state: 'linked' });
    expect(result.agents).toEqual([
      { agentId: 'clawboard-worker', action: 'created', state: 'linked' },
      { agentId: 'cto', action: 'unchanged', state: 'linked' },
    ]);
  });

  it('reconcileDocsLinksOnStartup still reconciles main when openclaw.json read fails', async () => {
    getWorkspaceLink.mockResolvedValueOnce({ state: 'linked' });
    getFileContent.mockRejectedValueOnce(
      Object.assign(new Error('workspace unavailable'), { status: 503 }),
    );

    const result = await reconcileDocsLinksOnStartup();

    expect(getWorkspaceLink).toHaveBeenCalledTimes(1);
    expect(getWorkspaceLink).toHaveBeenCalledWith('docs', 'main');
    expect(result).toEqual({
      main: { agentId: 'main', action: 'unchanged', state: 'linked' },
      agents: [],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Docs link startup reconciliation: failed to read openclaw.json',
      expect.objectContaining({ message: 'workspace unavailable', status: 503 }),
    );
  });
});
