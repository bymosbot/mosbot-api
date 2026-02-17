const express = require('express');
const pool = require('../db/pool');
const { authenticateToken } = require('./auth');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /api/v1/standups
 * List standups (newest first) with pagination
 */
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;

    logger.info('Fetching standups list', { userId: req.user.id, limit, offset });

    const result = await pool.query(
      `SELECT
        s.id,
        s.standup_date,
        s.title,
        s.timezone,
        s.status,
        s.started_at,
        s.completed_at,
        s.created_at,
        s.updated_at,
        COUNT(se.id)::int AS entry_count,
        ARRAY_AGG(
          JSON_BUILD_OBJECT(
            'agent_id',    se.agent_id,
            'user_id',     se.user_id,
            'user_name',   u.name,
            'avatar_url',  u.avatar_url
          ) ORDER BY se.turn_order
        ) FILTER (WHERE se.id IS NOT NULL) AS participants
      FROM standups s
      LEFT JOIN standup_entries se ON s.id = se.standup_id
      LEFT JOIN users u ON se.user_id = u.id
      GROUP BY s.id
      ORDER BY s.standup_date DESC, s.created_at DESC
      LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countResult = await pool.query('SELECT COUNT(*)::int AS total FROM standups');
    const total = countResult.rows[0]?.total || 0;

    res.json({
      data: result.rows,
      pagination: { limit, offset, total },
    });
  } catch (error) {
    logger.error('Failed to fetch standups list', { userId: req.user.id, error: error.message });
    next(error);
  }
});

/**
 * GET /api/v1/standups/latest
 * Get the most recent standup
 */
router.get('/latest', authenticateToken, async (req, res, next) => {
  try {
    logger.info('Fetching latest standup', { userId: req.user.id });

    const result = await pool.query(
      `SELECT
        s.id,
        s.standup_date,
        s.title,
        s.timezone,
        s.status,
        s.started_at,
        s.completed_at,
        s.created_at,
        s.updated_at,
        COUNT(se.id)::int AS entry_count,
        ARRAY_AGG(
          JSON_BUILD_OBJECT(
            'agent_id',    se.agent_id,
            'user_id',     se.user_id,
            'user_name',   u.name,
            'avatar_url',  u.avatar_url
          ) ORDER BY se.turn_order
        ) FILTER (WHERE se.id IS NOT NULL) AS participants
      FROM standups s
      LEFT JOIN standup_entries se ON s.id = se.standup_id
      LEFT JOIN users u ON se.user_id = u.id
      GROUP BY s.id
      ORDER BY s.standup_date DESC, s.created_at DESC
      LIMIT 1`
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'No standups found', status: 404 } });
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    logger.error('Failed to fetch latest standup', { userId: req.user.id, error: error.message });
    next(error);
  }
});

/**
 * GET /api/v1/standups/:id
 * Get a specific standup with full entries + transcript
 */
router.get('/:id', authenticateToken, async (req, res, next) => {
  try {
    const { id } = req.params;

    logger.info('Fetching standup detail', { userId: req.user.id, standupId: id });

    const standupResult = await pool.query(
      `SELECT id, standup_date, title, timezone, status, started_at, completed_at, created_at, updated_at
       FROM standups WHERE id = $1`,
      [id]
    );

    if (standupResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Standup not found', status: 404 } });
    }

    const standup = standupResult.rows[0];

    // Entries joined with users for name / avatar
    const entriesResult = await pool.query(
      `SELECT
        se.id,
        se.standup_id,
        se.agent_id,
        se.user_id,
        u.name    AS user_name,
        u.avatar_url,
        se.turn_order,
        se.yesterday,
        se.today,
        se.blockers,
        se.tasks,
        se.raw,
        se.created_at
      FROM standup_entries se
      LEFT JOIN users u ON se.user_id = u.id
      WHERE se.standup_id = $1
      ORDER BY se.turn_order ASC`,
      [id]
    );

    // Transcript messages (agent messages only — system messages are omitted)
    const messagesResult = await pool.query(
      `SELECT id, standup_id, kind, agent_id, content, created_at
       FROM standup_messages
       WHERE standup_id = $1
         AND kind = 'agent'
       ORDER BY created_at ASC`,
      [id]
    );

    res.json({
      data: {
        ...standup,
        entries: entriesResult.rows,
        messages: messagesResult.rows,
      },
    });
  } catch (error) {
    logger.error('Failed to fetch standup detail', {
      userId: req.user.id,
      standupId: req.params.id,
      error: error.message,
    });
    next(error);
  }
});

module.exports = router;
