require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const archiveDoneTasks = require('./jobs/archiveDoneTasks');

const app = express();
const PORT = process.env.PORT || 3000;

// Archive job configuration
const ENABLE_ARCHIVER = process.env.ENABLE_ARCHIVER !== 'false'; // Default: enabled
const ARCHIVE_CRON = process.env.ARCHIVE_CRON || '0 3 * * *'; // Default: 3 AM daily
// Validate ARCHIVE_AFTER_DAYS: must be between 0 and 365 days
const ARCHIVE_AFTER_DAYS_RAW = parseInt(process.env.ARCHIVE_AFTER_DAYS || '7', 10);
const ARCHIVE_AFTER_DAYS = Math.max(0, Math.min(ARCHIVE_AFTER_DAYS_RAW || 7, 365));
if (ARCHIVE_AFTER_DAYS_RAW !== ARCHIVE_AFTER_DAYS) {
  console.warn(`⚠️  ARCHIVE_AFTER_DAYS value ${ARCHIVE_AFTER_DAYS_RAW} is out of range (0-365), using ${ARCHIVE_AFTER_DAYS} instead`);
}

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));

// Rate limiting - more permissive in development
const isDevelopment = process.env.NODE_ENV !== 'production';
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDevelopment ? 1000 : 100, // 1000 requests in dev, 100 in production
  message: { error: { message: 'Too many requests, please try again later.', status: 429 } }
});
app.use('/api/', limiter);

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
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: {
      message: err.message || 'Internal server error',
      status: err.status || 500
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Not found', status: 404 } });
});

app.listen(PORT, () => {
  console.log(`🚀 MosBot API running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV}`);
  console.log(`🔧 Health check: http://localhost:${PORT}/health`);
  
  // Start archive scheduler
  if (ENABLE_ARCHIVER) {
    console.log(`⏰ Archive scheduler enabled (cron: ${ARCHIVE_CRON}, after ${ARCHIVE_AFTER_DAYS} days)`);
    
    cron.schedule(ARCHIVE_CRON, async () => {
      console.log('\n🕒 Running scheduled archive job...');
      try {
        await archiveDoneTasks(ARCHIVE_AFTER_DAYS);
      } catch (error) {
        console.error('Archive job error:', error);
      }
    });
    
    // Optional: Run once on startup for testing/immediate archival
    if (process.env.ARCHIVE_ON_STARTUP === 'true') {
      console.log('🔄 Running archive job on startup...');
      archiveDoneTasks(ARCHIVE_AFTER_DAYS).catch(err => {
        console.error('Startup archive job failed:', err);
      });
    }
  } else {
    console.log('⏰ Archive scheduler disabled');
  }
});

module.exports = app;
