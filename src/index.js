require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const runMigrations = require('./db/runMigrations');
const logger = require('./utils/logger');
const { startSessionUsagePoller } = require('./services/sessionUsageService');
const { startPricingRefreshJob } = require('./services/modelPricingService');

const app = express();
const PORT = process.env.PORT || 3000;

// Instance timezone — single source of truth for all time-related operations
const TIMEZONE = process.env.TIMEZONE || 'UTC';

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
app.use('/api/v1/standups', require('./routes/standups'));

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
      healthCheck: `http://localhost:${PORT}/health`,
    });
  });

  const pollIntervalMs = parseInt(process.env.SESSION_USAGE_POLL_INTERVAL_MS || '60000', 10);
  startSessionUsagePoller(pollIntervalMs);

  const pricingRefreshIntervalMs = parseInt(
    process.env.MODEL_PRICING_REFRESH_INTERVAL_MS || String(7 * 24 * 60 * 60 * 1000),
    10
  );
  startPricingRefreshJob(pricingRefreshIntervalMs);
}

start();

module.exports = app;
