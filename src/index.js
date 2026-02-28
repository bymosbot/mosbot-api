require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config');
const runMigrations = require('./db/runMigrations');
const logger = require('./utils/logger');
const { startSessionUsagePoller } = require('./services/sessionUsageService');
const { startPricingRefreshJob } = require('./services/modelPricingService');
const { startActivityIngestionPollers } = require('./services/activityIngestionService');
const { warnIfDeviceAuthNotConfigured } = require('./services/openclawGatewayClient');

config.validate();

const app = express();

// Security middleware
app.use(helmet());

app.use(
  cors({
    origin: config.corsOrigin,
    credentials: true,
  }),
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
      timezone: config.timezone,
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
  logger.error('Request error', {
    error: err.message,
    stack: err.stack,
    status: err.status || 500,
  });
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

  app.listen(config.port, () => {
    logger.info('MosBot API running', {
      port: config.port,
      environment: config.nodeEnv,
      healthCheck: `http://localhost:${config.port}/health`,
    });
    warnIfDeviceAuthNotConfigured();
  });

  startSessionUsagePoller(config.polling.sessionUsageIntervalMs);
  startPricingRefreshJob(config.polling.modelPricingRefreshIntervalMs);

  startActivityIngestionPollers();
}

start();

module.exports = app;
