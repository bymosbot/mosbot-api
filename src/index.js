require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cron = require('node-cron');
const archiveDoneTasks = require('./jobs/archiveDoneTasks');
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

// API routes
app.use('/api/v1/tasks', require('./routes/tasks'));
app.use('/api/v1/users', require('./routes/users'));
app.use('/api/v1/activity', require('./routes/activity'));
app.use('/api/v1/auth', require('./routes/auth'));
app.use('/api/v1/admin/users', require('./routes/admin/users'));
app.use('/api/v1/openclaw', require('./routes/openclaw'));

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
  });
}

start();

module.exports = app;
