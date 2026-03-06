const logger = require('../utils/logger');
const {
  getWorkspaceLink,
  ensureWorkspaceLink,
  getFileContent,
} = require('./openclawWorkspaceClient');

/**
 * Ensure docs link exists for one workspace target.
 * This helper is intentionally non-fatal for callers.
 *
 * @param {string} agentId - "main" or an agent id slug.
 * @returns {Promise<{agentId: string, action: string, state?: string}>}
 */
async function ensureDocsLinkIfMissing(agentId) {
  if (!agentId) {
    logger.warn('Docs link reconciliation skipped: missing agentId');
    return { agentId: null, action: 'skipped' };
  }

  try {
    const state = await getWorkspaceLink('docs', agentId);

    if (state?.state === 'missing') {
      await ensureWorkspaceLink('docs', agentId);
      return { agentId, action: 'created', state: 'linked' };
    }

    if (state?.state === 'linked') {
      return { agentId, action: 'unchanged', state: 'linked' };
    }

    if (state?.state === 'conflict') {
      logger.warn('Docs link reconciliation found conflict', {
        agentId,
        conflict: state.conflict || null,
      });
      return { agentId, action: 'conflict', state: 'conflict' };
    }

    logger.warn('Docs link reconciliation received unexpected state', {
      agentId,
      state: state?.state || null,
    });
    return { agentId, action: 'unknown', state: state?.state || null };
  } catch (error) {
    logger.warn('Docs link reconciliation failed', {
      agentId,
      message: error.message,
      status: error.status,
      code: error.code,
    });
    return { agentId, action: 'error' };
  }
}

function collectAgentIdsFromOpenClawConfig(content) {
  if (!content) return [];

  try {
    const parsed = JSON.parse(content);
    const agentsList = Array.isArray(parsed?.agents?.list) ? parsed.agents.list : [];
    const ids = agentsList
      .map((agent) => (typeof agent?.id === 'string' ? agent.id.trim() : ''))
      .filter(Boolean)
      .filter((id) => id !== 'main');
    return [...new Set(ids)];
  } catch (error) {
    logger.warn('Docs link startup reconciliation: could not parse openclaw.json', {
      message: error.message,
    });
    return [];
  }
}

/**
 * Startup reconciliation: ensure docs links for main and all configured OpenClaw agents.
 * This helper is intentionally non-fatal.
 *
 * @returns {Promise<{main: object, agents: object[]}>}
 */
async function reconcileDocsLinksOnStartup() {
  const mainResult = await ensureDocsLinkIfMissing('main');

  let agentIds = [];
  try {
    const openclawContent = await getFileContent('/openclaw.json');
    agentIds = collectAgentIdsFromOpenClawConfig(openclawContent);
  } catch (error) {
    logger.warn('Docs link startup reconciliation: failed to read openclaw.json', {
      message: error.message,
      status: error.status,
      code: error.code,
    });
    return { main: mainResult, agents: [] };
  }

  const agentResults = [];
  for (const agentId of agentIds) {
    const result = await ensureDocsLinkIfMissing(agentId);
    agentResults.push(result);
  }

  return { main: mainResult, agents: agentResults };
}

module.exports = {
  ensureDocsLinkIfMissing,
  reconcileDocsLinksOnStartup,
  collectAgentIdsFromOpenClawConfig,
};
