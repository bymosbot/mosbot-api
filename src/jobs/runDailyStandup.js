const config = require('../config');
const logger = require('../utils/logger');
const { generateDailyStandup } = require('../services/standupService');

/**
 * Run daily standup generation
 * This function is called by the cron scheduler at 8am daily
 */
async function runDailyStandup() {
  const timezone = config.timezone;

  logger.info('Daily standup job triggered', { timezone });

  try {
    const result = await generateDailyStandup(timezone);

    if (result.status === 'completed') {
      logger.info('Daily standup job completed successfully', {
        standupId: result.standupId,
        agentCount: result.agentCount,
        durationMs: result.durationMs,
      });
    } else {
      logger.error('Daily standup job failed', {
        message: result.message,
        durationMs: result.durationMs,
      });
    }

    return result;
  } catch (error) {
    logger.error('Daily standup job error', {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

module.exports = runDailyStandup;
