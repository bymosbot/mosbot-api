require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cron = require('node-cron');
const archiveDoneTasks = require('./jobs/archiveDoneTasks');
const purgeSubagentData = require('./jobs/purgeSubagentData');
const runMigrations = require('./db/runMigrations');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 3000;

// Archive job configuration
const ENABLE_ARCHIVER = process.env.ENABLE_ARCHIVER !== 'false'; // Default: enabled
const ARCHIVE_CRON = process.env.ARCHIVE_CRON || '0 3 * * *'; // Default: 3 AM daily
// Validate ARCHIVE_AFTER_DAYS: must be between 0 and 365 days
const ARCHIVE_AFTER_DAYS_RAW = parseInt(
  process.env.ARCHIVE_AFTER_DAYS || '7',
  10
);
const ARCHIVE_AFTER_DAYS = Math.max(
  0,
  Math.min(ARCHIVE_AFTER_DAYS_RAW || 7, 365)
);
if (ARCHIVE_AFTER_DAYS_RAW !== ARCHIVE_AFTER_DAYS) {
  logger.warn(
    `ARCHIVE_AFTER_DAYS value ${ARCHIVE_AFTER_DAYS_RAW} is out of range (0-365), using ${ARCHIVE_AFTER_DAYS} instead`,
    { originalValue: ARCHIVE_AFTER_DAYS_RAW, adjustedValue: ARCHIVE_AFTER_DAYS }
  );
}

// Instance timezone — single source of truth for all time-related operations
const TIMEZONE = process.env.TIMEZONE || 'UTC';

// Subagent retention purge configuration
const ENABLE_SUBAGENT_RETENTION_PURGE = process.env.ENABLE_SUBAGENT_RETENTION_PURGE !== 'false'; // Default: enabled
const SUBAGENT_RETENTION_CRON = process.env.SUBAGENT_RETENTION_CRON || '0 3 * * *'; // Default: 3 AM daily
const SUBAGENT_RETENTION_DAYS = parseInt(process.env.SUBAGENT_RETENTION_DAYS || '30', 10);
const ACTIVITY_LOG_RETENTION_DAYS = parseInt(process.env.ACTIVITY_LOG_RETENTION_DAYS || '7', 10);

// Security middleware
app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  })
);

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Public config endpoint — exposes non-sensitive instance settings to the dashboard
app.get('/api/v1/config', (req, res) => {
  res.json({
    data: {
      timezone: TIMEZONE,
    },
  });
});

// API routes
app.use('/api/v1/tasks', require('./routes/tasks'));
app.use('/api/v1/users', require('./routes/users'));
app.use('/api/v1/activity', require('./routes/activity'));
app.use('/api/v1/auth', require('./routes/auth'));
app.use('/api/v1/admin/users', require('./routes/admin/users'));
app.use('/api/v1/admin/models', require('./routes/admin/models'));
app.use('/api/v1/openclaw', require('./routes/openclaw'));
app.use('/api/v1/models', require('./routes/models'));

// Error handling middleware
app.use((err, req, res, _next) => {
  logger.error('Request error', { error: err.message, stack: err.stack, status: err.status || 500 });
  res.status(err.status || 500).json({
    error: {
      message: err.message || 'Internal server error',
      status: err.status || 500,
    },
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Not found', status: 404 } });
});

// Run migrations then start server (keeps pool open for API use)
async function start() {
  try {
    await runMigrations({ endPool: false });
  } catch (err) {
    logger.error('Startup migration failed, exiting', { error: err.message });
    process.exit(1);
  }

  app.listen(PORT, () => {
    logger.info('MosBot API running', {
      port: PORT,
      environment: process.env.NODE_ENV,
      healthCheck: `http://localhost:${PORT}/health`
    });

    // Start archive scheduler
    if (ENABLE_ARCHIVER) {
      logger.info('Archive scheduler enabled', {
        cron: ARCHIVE_CRON,
        archiveAfterDays: ARCHIVE_AFTER_DAYS
      });

      cron.schedule(ARCHIVE_CRON, async () => {
        logger.info('Running scheduled archive job');
        try {
          await archiveDoneTasks(ARCHIVE_AFTER_DAYS);
        } catch (error) {
          logger.error('Archive job error', { error: error.message });
        }
      });

      // Optional: Run once on startup for testing/immediate archival
      if (process.env.ARCHIVE_ON_STARTUP === 'true') {
        logger.info('Running archive job on startup');
        archiveDoneTasks(ARCHIVE_AFTER_DAYS).catch((err) => {
          logger.error('Startup archive job failed', { error: err.message });
        });
      }
    } else {
      logger.info('Archive scheduler disabled');
    }

    // Start subagent retention purge scheduler
    if (ENABLE_SUBAGENT_RETENTION_PURGE) {
      logger.info('Subagent retention purge scheduler enabled', {
        cron: SUBAGENT_RETENTION_CRON,
        completedRetentionDays: SUBAGENT_RETENTION_DAYS,
        activityLogRetentionDays: ACTIVITY_LOG_RETENTION_DAYS,
        archiveEnabled: process.env.RETENTION_ARCHIVE_ENABLED === 'true'
      });

      cron.schedule(SUBAGENT_RETENTION_CRON, async () => {
        logger.info('Running scheduled subagent retention purge job');
        try {
          await purgeSubagentData(SUBAGENT_RETENTION_DAYS, ACTIVITY_LOG_RETENTION_DAYS);
        } catch (error) {
          logger.error('Subagent retention purge job error', { error: error.message });
        }
      }, {
        timezone: TIMEZONE,
      });

      // Optional: Run once on startup for testing/immediate purge
      if (process.env.SUBAGENT_RETENTION_ON_STARTUP === 'true') {
        logger.info('Running subagent retention purge job on startup');
        purgeSubagentData(SUBAGENT_RETENTION_DAYS, ACTIVITY_LOG_RETENTION_DAYS).catch((err) => {
          logger.error('Startup subagent retention purge job failed', { error: err.message });
        });
      }
    } else {
      logger.info('Subagent retention purge scheduler disabled');
    }
  });
}

start();

module.exports = app;
