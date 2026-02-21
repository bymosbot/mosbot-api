const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const { validateAndNormalizeTags } = require('../utils/tags');

// Middleware to validate UUID
const validateUUID = (paramName) => (req, res, next) => {
  const id = req.params[paramName];
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  
  if (!uuidRegex.test(id)) {
    return res.status(400).json({ error: { message: 'Invalid UUID format', status: 400 } });
  }
  next();
};

// Middleware to validate task key format (TASK-1234)
const validateTaskKey = (paramName) => (req, res, next) => {
  const key = req.params[paramName];
  const keyRegex = /^TASK-\d+$/i;
  
  if (!keyRegex.test(key)) {
    return res.status(400).json({ error: { message: 'Invalid task key format. Expected TASK-{number}', status: 400 } });
  }
  next();
};

// Optional auth middleware - sets req.user if valid token present, but doesn't reject
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const jwtSecret = process.env.JWT_SECRET || 'default-secret-change-in-production';
    
    try {
      const decoded = jwt.verify(token, jwtSecret);
      req.user = decoded;
    } catch (_err) {
      // Invalid token - continue without setting req.user
    }
  }
  
  next();
};

// Helper to log task events
async function logTaskEvent(client, taskId, eventType, source, actorId, oldValues, newValues, meta = null) {
  await client.query(`
    INSERT INTO task_logs (task_id, event_type, source, actor_id, old_values, new_values, meta)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [
    taskId,
    eventType,
    source,
    actorId || null,
    oldValues ? JSON.stringify(oldValues) : null,
    newValues ? JSON.stringify(newValues) : null,
    meta ? JSON.stringify(meta) : null
  ]);
}

// Helper to compute diff between old and new task objects
function computeTaskDiff(oldTask, newTask) {
  const oldValues = {};
  const newValues = {};
  const fieldsToCompare = ['title', 'summary', 'status', 'priority', 'type', 'reporter_id', 'assignee_id', 'due_date', 'done_at', 'archived_at', 'tags', 'parent_task_id', 'preferred_model'];
  
  for (const field of fieldsToCompare) {
    const oldVal = oldTask[field];
    const newVal = newTask[field];
    
    // Special handling for array fields (tags)
    if (field === 'tags') {
      // Deep compare arrays
      const oldArray = oldVal || [];
      const newArray = newVal || [];
      
      if (oldArray.length !== newArray.length || 
          !oldArray.every((val, idx) => val === newArray[idx])) {
        oldValues[field] = oldVal;
        newValues[field] = newVal;
      }
    } else {
      // Compare values (handle null/undefined)
      if (oldVal !== newVal) {
        oldValues[field] = oldVal;
        newValues[field] = newVal;
      }
    }
  }
  
  return { oldValues, newValues };
}

// GET /api/v1/tasks - List all tasks with optional filtering
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const { status, assignee_id, reporter_id, priority, include_archived, limit = 100, offset = 0 } = req.query;
    
    // Validate pagination parameters
    const limitNum = Math.max(1, Math.min(parseInt(limit) || 100, 1000));
    const offsetNum = Math.max(0, parseInt(offset) || 0);
    
    let query = `
      SELECT 
        t.*,
        u_reporter.name as reporter_name,
        u_reporter.email as reporter_email,
        u_assignee.name as assignee_name,
        u_assignee.email as assignee_email,
        parent_task.task_number as parent_task_number,
        parent_task.title as parent_task_title
      FROM tasks t
      LEFT JOIN users u_reporter ON t.reporter_id = u_reporter.id
      LEFT JOIN users u_assignee ON t.assignee_id = u_assignee.id
      LEFT JOIN tasks parent_task ON t.parent_task_id = parent_task.id
      WHERE 1=1
    `;
    
    const params = [];
    let paramCount = 1;
    
    if (status) {
      query += ` AND t.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    } else if (include_archived !== 'true') {
      // Exclude archived tasks by default unless explicitly requested
      query += ' AND t.status != \'ARCHIVE\'';
    }
    
    if (assignee_id) {
      query += ` AND t.assignee_id = $${paramCount}`;
      params.push(assignee_id);
      paramCount++;
    }
    
    if (reporter_id) {
      query += ` AND t.reporter_id = $${paramCount}`;
      params.push(reporter_id);
      paramCount++;
    }
    
    if (priority) {
      query += ` AND t.priority = $${paramCount}`;
      params.push(priority);
      paramCount++;
    }
    
    query += ` ORDER BY t.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limitNum, offsetNum);
    
    const result = await pool.query(query, params);
    
    res.json({
      data: result.rows,
      pagination: {
        limit: limitNum,
        offset: offsetNum,
        total: result.rowCount
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/tasks/:id - Get a single task by ID
router.get('/:id', optionalAuth, validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(`
      SELECT 
        t.*,
        u_reporter.name as reporter_name,
        u_reporter.email as reporter_email,
        u_reporter.avatar_url as reporter_avatar,
        u_assignee.name as assignee_name,
        u_assignee.email as assignee_email,
        u_assignee.avatar_url as assignee_avatar,
        parent_task.task_number as parent_task_number,
        parent_task.title as parent_task_title
      FROM tasks t
      LEFT JOIN users u_reporter ON t.reporter_id = u_reporter.id
      LEFT JOIN users u_assignee ON t.assignee_id = u_assignee.id
      LEFT JOIN tasks parent_task ON t.parent_task_id = parent_task.id
      WHERE t.id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Task not found', status: 404 } });
    }
    
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/tasks/key/:key - Get a single task by key (TASK-1234)
router.get('/key/:key', optionalAuth, validateTaskKey('key'), async (req, res, next) => {
  try {
    const { key } = req.params;
    // Extract the number from TASK-1234 format
    const taskNumber = parseInt(key.split('-')[1], 10);
    
    const result = await pool.query(`
      SELECT 
        t.*,
        u_reporter.name as reporter_name,
        u_reporter.email as reporter_email,
        u_reporter.avatar_url as reporter_avatar,
        u_assignee.name as assignee_name,
        u_assignee.email as assignee_email,
        u_assignee.avatar_url as assignee_avatar
      FROM tasks t
      LEFT JOIN users u_reporter ON t.reporter_id = u_reporter.id
      LEFT JOIN users u_assignee ON t.assignee_id = u_assignee.id
      WHERE t.task_number = $1
    `, [taskNumber]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Task not found', status: 404 } });
    }
    
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/tasks - Create a new task
router.post('/', optionalAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      title,
      summary,
      status = 'PLANNING',
      priority,
      type = 'task',
      reporter_id,
      assignee_id,
      due_date,
      tags,
      parent_task_id,
      agent_cost_usd,
      agent_tokens_input,
      agent_tokens_input_cache,
      agent_tokens_output,
      agent_tokens_output_cache,
      agent_model,
      agent_model_provider,
      preferred_model
    } = req.body;
    
    // Validation
    if (!title || title.trim().length === 0) {
      return res.status(400).json({ error: { message: 'Title is required', status: 400 } });
    }
    
    if (title.length > 500) {
      return res.status(400).json({ error: { message: 'Title must be 500 characters or less', status: 400 } });
    }
    
    const validStatuses = ['PLANNING', 'TO DO', 'IN PROGRESS', 'DONE', 'ARCHIVE'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: { message: 'Invalid status', status: 400 } });
    }
    
    const validPriorities = ['High', 'Medium', 'Low'];
    if (priority && !validPriorities.includes(priority)) {
      return res.status(400).json({ error: { message: 'Invalid priority', status: 400 } });
    }
    
    const validTypes = ['task', 'bug', 'feature', 'improvement', 'research', 'epic'];
    if (type && !validTypes.includes(type)) {
      return res.status(400).json({ error: { message: 'Invalid type', status: 400 } });
    }
    
    // Validate agent usage fields
    if (agent_cost_usd !== undefined && agent_cost_usd !== null) {
      const cost = parseFloat(agent_cost_usd);
      if (isNaN(cost) || cost < 0) {
        return res.status(400).json({ error: { message: 'agent_cost_usd must be a non-negative number', status: 400 } });
      }
    }
    
    const tokenFields = [
      { name: 'agent_tokens_input', value: agent_tokens_input },
      { name: 'agent_tokens_input_cache', value: agent_tokens_input_cache },
      { name: 'agent_tokens_output', value: agent_tokens_output },
      { name: 'agent_tokens_output_cache', value: agent_tokens_output_cache }
    ];
    
    for (const field of tokenFields) {
      if (field.value !== undefined && field.value !== null) {
        const tokenCount = parseInt(field.value);
        if (isNaN(tokenCount) || tokenCount < 0 || !Number.isInteger(parseFloat(field.value))) {
          return res.status(400).json({ error: { message: `${field.name} must be a non-negative integer`, status: 400 } });
        }
      }
    }
    
    // Validate preferred_model field
    if (preferred_model !== undefined && preferred_model !== null) {
      if (typeof preferred_model !== 'string' || preferred_model.trim().length === 0) {
        return res.status(400).json({ error: { message: 'preferred_model must be a non-empty string', status: 400 } });
      }
      if (preferred_model.length > 200) {
        return res.status(400).json({ error: { message: 'preferred_model must be 200 characters or less', status: 400 } });
      }
    }
    
    // Validate and normalize tags
    let normalizedTags = null;
    if (tags !== undefined && tags !== null) {
      const tagResult = validateAndNormalizeTags(tags);
      if (tagResult.error) {
        return res.status(400).json({ error: { message: tagResult.error, status: 400 } });
      }
      normalizedTags = tagResult.tags;
      
      // Log tag creation
      if (normalizedTags && normalizedTags.length > 0) {
        logger.info('Tags created on task', {
          action: 'create_task_tags',
          actor_id: req.user?.id || null,
          original_tags: tags,
          normalized_tags: normalizedTags,
          tag_count: normalizedTags.length
        });
      }
    }
    
    // Validate parent_task_id if provided
    if (parent_task_id) {
      const parentResult = await pool.query('SELECT id FROM tasks WHERE id = $1', [parent_task_id]);
      if (parentResult.rows.length === 0) {
        return res.status(400).json({ error: { message: 'Parent task not found', status: 400 } });
      }
    }
    
    // Auto-set reporter_id to authenticated user if not provided
    const finalReporterId = reporter_id || req.user?.id || null;
    
    await client.query('BEGIN');
    
    const result = await client.query(`
      INSERT INTO tasks (title, summary, status, priority, type, reporter_id, assignee_id, due_date, tags, parent_task_id, 
        agent_cost_usd, agent_tokens_input, agent_tokens_input_cache, agent_tokens_output, agent_tokens_output_cache, 
        agent_model, agent_model_provider, preferred_model)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *
    `, [title, summary, status, priority, type, finalReporterId, assignee_id, due_date, normalizedTags, parent_task_id || null,
        agent_cost_usd ?? null, agent_tokens_input ?? null, agent_tokens_input_cache ?? null, 
        agent_tokens_output ?? null, agent_tokens_output_cache ?? null, agent_model ?? null, agent_model_provider ?? null,
        preferred_model ?? null]);
    
    const newTask = result.rows[0];
    
    // Log the creation event
    const newValues = {
      title: newTask.title,
      summary: newTask.summary,
      status: newTask.status,
      type: newTask.type,
      priority: newTask.priority,
      reporter_id: newTask.reporter_id,
      assignee_id: newTask.assignee_id,
      due_date: newTask.due_date,
      tags: newTask.tags,
      parent_task_id: newTask.parent_task_id,
      preferred_model: newTask.preferred_model
    };
    
    await logTaskEvent(
      client,
      newTask.id,
      'CREATED',
      'api',
      req.user?.id,
      null,
      newValues
    );
    
    await client.query('COMMIT');
    
    // Fetch the complete task with reporter and assignee names
    const completeTask = await client.query(`
      SELECT 
        t.*,
        u_reporter.name as reporter_name,
        u_reporter.email as reporter_email,
        u_assignee.name as assignee_name,
        u_assignee.email as assignee_email,
        parent_task.task_number as parent_task_number,
        parent_task.title as parent_task_title
      FROM tasks t
      LEFT JOIN users u_reporter ON t.reporter_id = u_reporter.id
      LEFT JOIN users u_assignee ON t.assignee_id = u_assignee.id
      LEFT JOIN tasks parent_task ON t.parent_task_id = parent_task.id
      WHERE t.id = $1
    `, [newTask.id]);
    
    res.status(201).json({ data: completeTask.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// PUT /api/v1/tasks/:id - Update a task
router.put('/:id', optionalAuth, validateUUID('id'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const {
      title,
      summary,
      status,
      priority,
      type,
      reporter_id,
      assignee_id,
      due_date,
      tags,
      parent_task_id,
      agent_cost_usd,
      agent_tokens_input,
      agent_tokens_input_cache,
      agent_tokens_output,
      agent_tokens_output_cache,
      agent_model,
      agent_model_provider,
      preferred_model
    } = req.body;
    
    await client.query('BEGIN');
    
    // Fetch full existing task for diff computation
    const existing = await client.query(
      'SELECT id, title, summary, status, priority, type, reporter_id, assignee_id, due_date, done_at, archived_at, tags, parent_task_id, preferred_model FROM tasks WHERE id = $1',
      [id]
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Task not found', status: 404 } });
    }
    
    const oldTask = existing.rows[0];
    const currentStatus = oldTask.status;
    
    // Validation
    if (title !== undefined && title.trim().length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'Title cannot be empty', status: 400 } });
    }
    
    if (title && title.length > 500) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'Title must be 500 characters or less', status: 400 } });
    }
    
    const validStatuses = ['PLANNING', 'TO DO', 'IN PROGRESS', 'DONE', 'ARCHIVE'];
    if (status && !validStatuses.includes(status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'Invalid status', status: 400 } });
    }
    
    const validPriorities = ['High', 'Medium', 'Low'];
    if (priority && !validPriorities.includes(priority)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'Invalid priority', status: 400 } });
    }
    
    const validTypes = ['task', 'bug', 'feature', 'improvement', 'research', 'epic'];
    if (type && !validTypes.includes(type)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'Invalid type', status: 400 } });
    }
    
    // Validate agent usage fields
    if (agent_cost_usd !== undefined && agent_cost_usd !== null) {
      const cost = parseFloat(agent_cost_usd);
      if (isNaN(cost) || cost < 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: { message: 'agent_cost_usd must be a non-negative number', status: 400 } });
      }
    }
    
    const tokenFieldsUpdate = [
      { name: 'agent_tokens_input', value: agent_tokens_input },
      { name: 'agent_tokens_input_cache', value: agent_tokens_input_cache },
      { name: 'agent_tokens_output', value: agent_tokens_output },
      { name: 'agent_tokens_output_cache', value: agent_tokens_output_cache }
    ];
    
    for (const field of tokenFieldsUpdate) {
      if (field.value !== undefined && field.value !== null) {
        const tokenCount = parseInt(field.value);
        if (isNaN(tokenCount) || tokenCount < 0 || !Number.isInteger(parseFloat(field.value))) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: { message: `${field.name} must be a non-negative integer`, status: 400 } });
        }
      }
    }
    
    // Validate preferred_model field
    if (preferred_model !== undefined && preferred_model !== null) {
      if (typeof preferred_model !== 'string' || preferred_model.trim().length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: { message: 'preferred_model must be a non-empty string', status: 400 } });
      }
      if (preferred_model.length > 200) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: { message: 'preferred_model must be 200 characters or less', status: 400 } });
      }
    }
    
    // Validate parent_task_id if provided
    if (parent_task_id !== undefined && parent_task_id !== null) {
      const parentResult = await client.query('SELECT id FROM tasks WHERE id = $1', [parent_task_id]);
      if (parentResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: { message: 'Parent task not found', status: 400 } });
      }
      // Prevent task from being its own parent
      if (parent_task_id === id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: { message: 'Task cannot be its own parent', status: 400 } });
      }
    }
    
    // Hard blocking: Check dependencies before allowing status change to IN PROGRESS or DONE
    if (status && (status === 'IN PROGRESS' || status === 'DONE') && status !== currentStatus) {
      const blockingDeps = await client.query(`
        SELECT 
          t.task_number,
          t.title,
          t.status
        FROM task_dependencies td
        JOIN tasks t ON td.depends_on_task_id = t.id
        WHERE td.task_id = $1 AND t.status != 'DONE'
      `, [id]);
      
      if (blockingDeps.rows.length > 0) {
        const blockingTasks = blockingDeps.rows.map(t => `TASK-${t.task_number} (${t.title})`).join(', ');
        const blockingTaskKeys = blockingDeps.rows.map(t => `TASK-${t.task_number}`);
        
        await client.query('ROLLBACK');
        
        // Log blocking event after rollback (use separate query so it persists)
        const actorId = req.user?.id || null;
        try {
          await pool.query(`
            INSERT INTO task_logs (task_id, event_type, source, actor_id, old_values, new_values, meta)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [
            id,
            'STATUS_CHANGE_BLOCKED',
            'API',
            actorId,
            JSON.stringify({ status: currentStatus }),
            JSON.stringify({ attempted_status: status }),
            JSON.stringify({ blocking_tasks: blockingTaskKeys })
          ]);
        } catch (logError) {
          // Don't fail the request if logging fails, but log the error
          console.error('Failed to log dependency blocking event:', logError);
        }
        
        return res.status(409).json({ 
          error: { 
            message: `Cannot move to ${status}. Task is blocked by: ${blockingTasks}`,
            status: 409,
            blocking_tasks: blockingDeps.rows.map(t => ({
              key: `TASK-${t.task_number}`,
              title: t.title,
              status: t.status
            }))
          }
        });
      }
    }
    
    // Validate and normalize tags
    let normalizedTags = undefined;
    if (tags !== undefined) {
      if (tags === null) {
        normalizedTags = null;
      } else {
        const tagResult = validateAndNormalizeTags(tags);
        if (tagResult.error) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: { message: tagResult.error, status: 400 } });
        }
        normalizedTags = tagResult.tags;
        
        // Log tag update if tags are changing
        const oldTags = oldTask.tags || [];
        const newTags = normalizedTags || [];
        const tagsChanged = JSON.stringify(oldTags.sort()) !== JSON.stringify(newTags.sort());
        
        if (tagsChanged) {
          logger.info('Tags updated on task', {
            action: 'update_task_tags',
            actor_id: req.user?.id || null,
            task_id: id,
            original_tags: tags,
            normalized_tags: normalizedTags,
            old_tags: oldTags,
            new_tags: newTags,
            tag_count: newTags.length
          });
        }
      }
    }
    
    // Build dynamic update query
    const updates = [];
    const params = [];
    let paramCount = 1;
    
    if (title !== undefined) {
      updates.push(`title = $${paramCount}`);
      params.push(title);
      paramCount++;
    }
    
    if (summary !== undefined) {
      updates.push(`summary = $${paramCount}`);
      params.push(summary);
      paramCount++;
    }
    
    if (status !== undefined) {
      updates.push(`status = $${paramCount}`);
      params.push(status);
      paramCount++;
    }
    
    if (priority !== undefined) {
      updates.push(`priority = $${paramCount}`);
      params.push(priority);
      paramCount++;
    }
    
    if (type !== undefined) {
      updates.push(`type = $${paramCount}`);
      params.push(type);
      paramCount++;
    }
    
    if (reporter_id !== undefined) {
      updates.push(`reporter_id = $${paramCount}`);
      params.push(reporter_id);
      paramCount++;
    }
    
    if (assignee_id !== undefined) {
      updates.push(`assignee_id = $${paramCount}`);
      params.push(assignee_id);
      paramCount++;
    }
    
    if (due_date !== undefined) {
      updates.push(`due_date = $${paramCount}`);
      params.push(due_date);
      paramCount++;
    }
    
    if (normalizedTags !== undefined) {
      updates.push(`tags = $${paramCount}`);
      params.push(normalizedTags);
      paramCount++;
    }
    
    if (parent_task_id !== undefined) {
      updates.push(`parent_task_id = $${paramCount}`);
      params.push(parent_task_id);
      paramCount++;
    }
    
    // Handle agent usage fields
    if (agent_cost_usd !== undefined) {
      updates.push(`agent_cost_usd = $${paramCount}`);
      params.push(agent_cost_usd);
      paramCount++;
    }
    
    if (agent_tokens_input !== undefined) {
      updates.push(`agent_tokens_input = $${paramCount}`);
      params.push(agent_tokens_input);
      paramCount++;
    }
    
    if (agent_tokens_input_cache !== undefined) {
      updates.push(`agent_tokens_input_cache = $${paramCount}`);
      params.push(agent_tokens_input_cache);
      paramCount++;
    }
    
    if (agent_tokens_output !== undefined) {
      updates.push(`agent_tokens_output = $${paramCount}`);
      params.push(agent_tokens_output);
      paramCount++;
    }
    
    if (agent_tokens_output_cache !== undefined) {
      updates.push(`agent_tokens_output_cache = $${paramCount}`);
      params.push(agent_tokens_output_cache);
      paramCount++;
    }
    
    if (agent_model !== undefined) {
      updates.push(`agent_model = $${paramCount}`);
      params.push(agent_model);
      paramCount++;
    }
    
    if (agent_model_provider !== undefined) {
      updates.push(`agent_model_provider = $${paramCount}`);
      params.push(agent_model_provider);
      paramCount++;
    }
    
    if (preferred_model !== undefined) {
      updates.push(`preferred_model = $${paramCount}`);
      params.push(preferred_model);
      paramCount++;
    }
    
    // Handle status transitions for done_at and archived_at
    if (status !== undefined && status !== currentStatus) {
      // Transition to DONE: set done_at
      if (status === 'DONE') {
        updates.push('done_at = NOW()');
      }
      // Transition away from DONE: clear done_at (but preserve it when archiving)
      if (currentStatus === 'DONE' && status !== 'DONE' && status !== 'ARCHIVE') {
        updates.push('done_at = NULL');
      }
      // Transition to ARCHIVE: set archived_at
      if (status === 'ARCHIVE') {
        updates.push('archived_at = NOW()');
      }
      // Transition away from ARCHIVE: clear archived_at
      if (currentStatus === 'ARCHIVE' && status !== 'ARCHIVE') {
        updates.push('archived_at = NULL');
      }
    }
    
    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'No fields to update', status: 400 } });
    }
    
    params.push(id);
    
    const result = await client.query(`
      UPDATE tasks
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `, params);
    
    const updatedTask = result.rows[0];
    
    // Compute diff and log the change
    const { oldValues, newValues } = computeTaskDiff(oldTask, updatedTask);
    
    // Determine event type
    let eventType = 'UPDATED';
    if (oldValues.status && oldValues.status !== newValues.status) {
      if (newValues.status === 'ARCHIVE' && currentStatus !== 'ARCHIVE') {
        eventType = 'ARCHIVED_MANUAL';
      } else if (oldValues.status === 'ARCHIVE' && newValues.status !== 'ARCHIVE') {
        eventType = 'RESTORED';
      } else {
        eventType = 'STATUS_CHANGED';
      }
    }
    
    await logTaskEvent(
      client,
      id,
      eventType,
      'api',
      req.user?.id,
      oldValues,
      newValues
    );
    
    await client.query('COMMIT');
    
    // Fetch the complete task with reporter, assignee, and parent task information
    const completeTask = await client.query(`
      SELECT 
        t.*,
        u_reporter.name as reporter_name,
        u_reporter.email as reporter_email,
        u_assignee.name as assignee_name,
        u_assignee.email as assignee_email,
        parent_task.task_number as parent_task_number,
        parent_task.title as parent_task_title
      FROM tasks t
      LEFT JOIN users u_reporter ON t.reporter_id = u_reporter.id
      LEFT JOIN users u_assignee ON t.assignee_id = u_assignee.id
      LEFT JOIN tasks parent_task ON t.parent_task_id = parent_task.id
      WHERE t.id = $1
    `, [id]);
    
    res.json({ data: completeTask.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// PATCH /api/v1/tasks/:id - Partial update a task
router.patch('/:id', validateUUID('id'), async (req, res, next) => {
  // Reuse PUT logic for PATCH
  req.method = 'PUT';
  return router.handle(req, res, next);
});

// GET /api/v1/tasks/:id/history - Get history/audit log for a task
router.get('/:id/history', optionalAuth, validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { limit = 100, offset = 0 } = req.query;
    
    // First check if task exists
    const taskExists = await pool.query('SELECT id FROM tasks WHERE id = $1', [id]);
    if (taskExists.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Task not found', status: 404 } });
    }
    
    const result = await pool.query(`
      SELECT 
        tl.*,
        u.name as actor_name,
        u.email as actor_email,
        u.avatar_url as actor_avatar
      FROM task_logs tl
      LEFT JOIN users u ON tl.actor_id = u.id
      WHERE tl.task_id = $1
      ORDER BY tl.occurred_at DESC
      LIMIT $2 OFFSET $3
    `, [id, parseInt(limit), parseInt(offset)]);
    
    res.json({
      data: result.rows,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        total: result.rowCount
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/tasks/:id/activity - Get activity logs for a task
router.get('/:id/activity', optionalAuth, validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { limit = 100, offset = 0 } = req.query;
    
    // First check if task exists
    const taskExists = await pool.query('SELECT id FROM tasks WHERE id = $1', [id]);
    if (taskExists.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Task not found', status: 404 } });
    }
    
    // Fetch activity logs for this task
    const result = await pool.query(`
      SELECT id, timestamp, title, description, category, task_id, created_at
      FROM activity_logs
      WHERE task_id = $1
      ORDER BY timestamp DESC
      LIMIT $2 OFFSET $3
    `, [id, parseInt(limit), parseInt(offset)]);
    
    res.json({
      data: result.rows,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        total: result.rowCount
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/tasks/:id/timeline - Get unified timeline of comments + task_log events
// Returns merged, chronological feed (oldest first) for the Comments tab.
// Excludes COMMENT_* event types (redundant — the comment itself is shown).
router.get('/:id/timeline', optionalAuth, validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const taskExists = await pool.query('SELECT id FROM tasks WHERE id = $1', [id]);
    if (taskExists.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Task not found', status: 404 } });
    }

    const [commentsResult, eventsResult] = await Promise.all([
      pool.query(
        `SELECT
           c.id,
           'comment' AS type,
           c.body,
           c.author_id,
           u.name  AS author_name,
           u.email AS author_email,
           u.avatar_url AS author_avatar,
           c.created_at,
           c.updated_at,
           c.created_at AS occurred_at
         FROM task_comments c
         LEFT JOIN users u ON u.id = c.author_id
         WHERE c.task_id = $1`,
        [id]
      ),
      pool.query(
        `SELECT
           tl.id,
           'event' AS type,
           tl.event_type,
           tl.actor_id,
           u.name  AS actor_name,
           u.email AS actor_email,
           tl.occurred_at,
           tl.meta,
           tl.old_values,
           tl.new_values,
           tl.source,
           tl.occurred_at AS occurred_at
         FROM task_logs tl
         LEFT JOIN users u ON u.id = tl.actor_id
         WHERE tl.task_id = $1
           AND tl.event_type NOT IN ('COMMENT_CREATED', 'COMMENT_UPDATED', 'COMMENT_DELETED')`,
        [id]
      ),
    ]);

    const items = [...commentsResult.rows, ...eventsResult.rows].sort(
      (a, b) => new Date(a.occurred_at) - new Date(b.occurred_at)
    );

    res.json({ data: items });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/tasks/:id/comments - Get comments for a task
router.get('/:id/comments', optionalAuth, validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { limit = 100, offset = 0 } = req.query;

    // First check if task exists
    const taskExists = await pool.query('SELECT id FROM tasks WHERE id = $1', [id]);
    if (taskExists.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Task not found', status: 404 } });
    }

    const result = await pool.query(
      `
        SELECT
          c.*,
          u.name as author_name,
          u.email as author_email,
          u.avatar_url as author_avatar
        FROM task_comments c
        LEFT JOIN users u ON c.author_id = u.id
        WHERE c.task_id = $1
        ORDER BY c.created_at ASC
        LIMIT $2 OFFSET $3
      `,
      [id, parseInt(limit), parseInt(offset)]
    );

    res.json({
      data: result.rows,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        total: result.rowCount
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/tasks/:id/comments - Create a new comment on a task
router.post('/:id/comments', optionalAuth, validateUUID('id'), async (req, res, next) => {
  let client;
  try {
    const { id } = req.params;
    const { body } = req.body || {};

    if (!req.user?.id) {
      return res.status(401).json({ error: { message: 'Authorization required', status: 401 } });
    }

    const commentBody = typeof body === 'string' ? body.trim() : '';
    if (!commentBody) {
      return res.status(400).json({ error: { message: 'Comment body is required', status: 400 } });
    }

    if (commentBody.length > 5000) {
      return res.status(400).json({ error: { message: 'Comment body must be 5000 characters or less', status: 400 } });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // First check if task exists
    const taskExists = await client.query('SELECT id FROM tasks WHERE id = $1', [id]);
    if (taskExists.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Task not found', status: 404 } });
    }

    const insertResult = await client.query(
      `
        INSERT INTO task_comments (task_id, author_id, body)
        VALUES ($1, $2, $3)
        RETURNING *
      `,
      [id, req.user.id, commentBody]
    );

    const inserted = insertResult.rows[0];

    const commentWithAuthor = await client.query(
      `
        SELECT
          c.*,
          u.name as author_name,
          u.email as author_email,
          u.avatar_url as author_avatar
        FROM task_comments c
        LEFT JOIN users u ON c.author_id = u.id
        WHERE c.id = $1
      `,
      [inserted.id]
    );

    // Log comment creation to task_logs
    await logTaskEvent(
      client,
      id,
      'COMMENT_CREATED',
      'api',
      req.user.id,
      null,
      null,
      { comment_id: inserted.id, comment_body: commentBody }
    );

    await client.query('COMMIT');

    return res.status(201).json({ data: commentWithAuthor.rows[0] });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    return next(error);
  } finally {
    if (client) {
      client.release();
    }
  }
});

// PATCH /api/v1/tasks/:taskId/comments/:commentId - Update a comment
router.patch('/:taskId/comments/:commentId', optionalAuth, validateUUID('taskId'), validateUUID('commentId'), async (req, res, next) => {
  let client;
  try {
    const { taskId, commentId } = req.params;
    const { body } = req.body || {};

    if (!req.user?.id) {
      return res.status(401).json({ error: { message: 'Authorization required', status: 401 } });
    }

    const commentBody = typeof body === 'string' ? body.trim() : '';
    if (!commentBody) {
      return res.status(400).json({ error: { message: 'Comment body is required', status: 400 } });
    }

    if (commentBody.length > 5000) {
      return res.status(400).json({ error: { message: 'Comment body must be 5000 characters or less', status: 400 } });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Fetch existing comment with author and user info
    const existingResult = await client.query(
      `
        SELECT c.*, u.role as author_role
        FROM task_comments c
        LEFT JOIN users u ON c.author_id = u.id
        WHERE c.id = $1 AND c.task_id = $2
      `,
      [commentId, taskId]
    );

    if (existingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Comment not found', status: 404 } });
    }

    const existingComment = existingResult.rows[0];

    // Authorization check: only author or admin/agent/owner can edit
    const isAuthor = existingComment.author_id === req.user.id;
    const isAdminOrOwner = req.user.role === 'admin' || req.user.role === 'agent' || req.user.role === 'owner';

    if (!isAuthor && !isAdminOrOwner) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'Only the comment author or an admin can edit this comment', status: 403 } });
    }

    // Update comment
    await client.query(
      `
        UPDATE task_comments
        SET body = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING *
      `,
      [commentBody, commentId]
    );

    // Fetch updated comment with author info
    const commentWithAuthor = await client.query(
      `
        SELECT
          c.*,
          u.name as author_name,
          u.email as author_email,
          u.avatar_url as author_avatar
        FROM task_comments c
        LEFT JOIN users u ON c.author_id = u.id
        WHERE c.id = $1
      `,
      [commentId]
    );

    // Log comment update to task_logs
    await logTaskEvent(
      client,
      taskId,
      'COMMENT_UPDATED',
      'api',
      req.user.id,
      { comment_body: existingComment.body },
      { comment_body: commentBody },
      { comment_id: commentId }
    );

    await client.query('COMMIT');

    return res.json({ data: commentWithAuthor.rows[0] });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    return next(error);
  } finally {
    if (client) {
      client.release();
    }
  }
});

// DELETE /api/v1/tasks/:taskId/comments/:commentId - Delete a comment
router.delete('/:taskId/comments/:commentId', optionalAuth, validateUUID('taskId'), validateUUID('commentId'), async (req, res, next) => {
  let client;
  try {
    const { taskId, commentId } = req.params;

    if (!req.user?.id) {
      return res.status(401).json({ error: { message: 'Authorization required', status: 401 } });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Fetch existing comment with author info
    const existingResult = await client.query(
      `
        SELECT c.*, u.role as author_role
        FROM task_comments c
        LEFT JOIN users u ON c.author_id = u.id
        WHERE c.id = $1 AND c.task_id = $2
      `,
      [commentId, taskId]
    );

    if (existingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Comment not found', status: 404 } });
    }

    const existingComment = existingResult.rows[0];

    // Authorization check: only author or admin/agent/owner can delete
    const isAuthor = existingComment.author_id === req.user.id;
    const isAdminOrOwner = req.user.role === 'admin' || req.user.role === 'agent' || req.user.role === 'owner';

    if (!isAuthor && !isAdminOrOwner) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'Only the comment author or an admin can delete this comment', status: 403 } });
    }

    // Log comment deletion to task_logs before deleting
    await logTaskEvent(
      client,
      taskId,
      'COMMENT_DELETED',
      'api',
      req.user.id,
      { comment_body: existingComment.body },
      null,
      { comment_id: commentId }
    );

    // Delete comment
    await client.query('DELETE FROM task_comments WHERE id = $1', [commentId]);

    await client.query('COMMIT');

    return res.status(204).send();
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    return next(error);
  } finally {
    if (client) {
      client.release();
    }
  }
});

// DELETE /api/v1/tasks/:id - Delete a task
router.delete('/:id', optionalAuth, validateUUID('id'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    
    await client.query('BEGIN');
    
    // Fetch task before deleting to log the event
    const existing = await client.query('SELECT title, status FROM tasks WHERE id = $1', [id]);
    
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Task not found', status: 404 } });
    }
    
    const oldTask = existing.rows[0];
    
    // Log deletion before actually deleting (since cascade will remove logs)
    await logTaskEvent(
      client,
      id,
      'DELETED',
      'api',
      req.user?.id,
      { title: oldTask.title, status: oldTask.status },
      null
    );
    
    await client.query('DELETE FROM tasks WHERE id = $1', [id]);
    
    await client.query('COMMIT');
    
    res.status(204).send();
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// GET /api/v1/tasks/:id/dependencies - Get task dependencies
router.get('/:id/dependencies', optionalAuth, validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Check if task exists
    const taskExists = await pool.query('SELECT id, task_number FROM tasks WHERE id = $1', [id]);
    if (taskExists.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Task not found', status: 404 } });
    }
    
    // Get tasks this task depends on (blockers)
    const dependsOn = await pool.query(`
      SELECT 
        t.*,
        u_reporter.name as reporter_name,
        u_reporter.email as reporter_email,
        u_assignee.name as assignee_name,
        u_assignee.email as assignee_email,
        parent_task.task_number as parent_task_number,
        parent_task.title as parent_task_title
      FROM task_dependencies td
      JOIN tasks t ON td.depends_on_task_id = t.id
      LEFT JOIN users u_reporter ON t.reporter_id = u_reporter.id
      LEFT JOIN users u_assignee ON t.assignee_id = u_assignee.id
      LEFT JOIN tasks parent_task ON t.parent_task_id = parent_task.id
      WHERE td.task_id = $1
    `, [id]);
    
    // Get tasks that depend on this task (dependents)
    const dependents = await pool.query(`
      SELECT 
        t.*,
        u_reporter.name as reporter_name,
        u_reporter.email as reporter_email,
        u_assignee.name as assignee_name,
        u_assignee.email as assignee_email,
        parent_task.task_number as parent_task_number,
        parent_task.title as parent_task_title
      FROM task_dependencies td
      JOIN tasks t ON td.task_id = t.id
      LEFT JOIN users u_reporter ON t.reporter_id = u_reporter.id
      LEFT JOIN users u_assignee ON t.assignee_id = u_assignee.id
      LEFT JOIN tasks parent_task ON t.parent_task_id = parent_task.id
      WHERE td.depends_on_task_id = $1
    `, [id]);
    
    res.json({
      data: {
        depends_on: dependsOn.rows,
        dependents: dependents.rows
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/tasks/:id/dependencies - Add a dependency
router.post('/:id/dependencies', optionalAuth, validateUUID('id'), async (req, res, next) => {
  // Require authentication
  if (!req.user) {
    return res.status(401).json({ error: { message: 'Authorization required', status: 401 } });
  }
  
  const { id } = req.params;
  const { depends_on_task_id } = req.body;
  
  if (!depends_on_task_id) {
    return res.status(400).json({ error: { message: 'depends_on_task_id is required', status: 400 } });
  }
  
  // Prevent self-dependency (check before acquiring client)
  if (id === depends_on_task_id) {
    return res.status(400).json({ error: { message: 'Task cannot depend on itself', status: 400 } });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Check if both tasks exist
    const taskCheck = await client.query(
      'SELECT id, task_number FROM tasks WHERE id = $1 OR id = $2',
      [id, depends_on_task_id]
    );
    
    if (taskCheck.rows.length !== 2) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'One or both tasks not found', status: 404 } });
    }
    
    // Check for circular dependencies
    const hasCircular = await client.query(
      'SELECT check_circular_dependency($1, $2) as has_circular',
      [id, depends_on_task_id]
    );
    
    if (hasCircular.rows[0].has_circular) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: { 
          message: 'Cannot add dependency: would create a circular dependency', 
          status: 400 
        }
      });
    }
    
    // Check if dependency already exists
    const existing = await client.query(
      'SELECT 1 FROM task_dependencies WHERE task_id = $1 AND depends_on_task_id = $2',
      [id, depends_on_task_id]
    );
    
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'Dependency already exists', status: 409 } });
    }
    
    // Add the dependency
    await client.query(
      'INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)',
      [id, depends_on_task_id]
    );
    
    await client.query('COMMIT');
    
    res.status(201).json({ 
      data: { 
        task_id: id, 
        depends_on_task_id 
      } 
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// DELETE /api/v1/tasks/:id/dependencies/:dependsOnId - Remove a dependency
router.delete('/:id/dependencies/:dependsOnId', optionalAuth, validateUUID('id'), validateUUID('dependsOnId'), async (req, res, next) => {
  // Require authentication
  if (!req.user) {
    return res.status(401).json({ error: { message: 'Authorization required', status: 401 } });
  }
  
  const client = await pool.connect();
  try {
    const { id, dependsOnId } = req.params;
    
    await client.query('BEGIN');
    
    // Delete the dependency
    const result = await client.query(
      'DELETE FROM task_dependencies WHERE task_id = $1 AND depends_on_task_id = $2 RETURNING *',
      [id, dependsOnId]
    );
    
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Dependency not found', status: 404 } });
    }
    
    await client.query('COMMIT');
    
    res.status(204).send();
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// GET /api/v1/tasks/:id/subtasks - Get subtasks of a task (children)
router.get('/:id/subtasks', optionalAuth, validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Check if task exists
    const taskExists = await pool.query('SELECT id FROM tasks WHERE id = $1', [id]);
    if (taskExists.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Task not found', status: 404 } });
    }
    
    // Get subtasks ordered by parent_sort_order
    const result = await pool.query(`
      SELECT 
        t.*,
        u_reporter.name as reporter_name,
        u_reporter.email as reporter_email,
        u_assignee.name as assignee_name,
        u_assignee.email as assignee_email
      FROM tasks t
      LEFT JOIN users u_reporter ON t.reporter_id = u_reporter.id
      LEFT JOIN users u_assignee ON t.assignee_id = u_assignee.id
      WHERE t.parent_task_id = $1
      ORDER BY t.parent_sort_order NULLS LAST, t.created_at ASC
    `, [id]);
    
    res.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/tasks/:id/subagents - Get subagent execution attempts for a task
router.get('/:id/subagents', require('../routes/auth').authenticateToken, validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    
    logger.info('Fetching subagents for task', { taskId: id, userId: req.user.id });
    
    // Check if task exists
    const taskExists = await pool.query('SELECT id, task_number FROM tasks WHERE id = $1', [id]);
    if (taskExists.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Task not found', status: 404 } });
    }
    
    const taskNumber = taskExists.rows[0].task_number;
    
    // Import services
    const { getAllSubagents } = require('../services/subagentsRuntimeService');
    const { sessionsList, sessionsHistory } = require('../services/openclawGatewayClient');
    
    // Get runtime subagent entries for this task
    const { running: runtimeRunning, queued: runtimeQueued, completed: runtimeCompleted } = await getAllSubagents({ taskId: id });
    
    // Build initial attempts map from runtime data
    const attemptsMap = new Map();
    
    // Helper to add or merge attempt
    const addAttempt = (key, data, source) => {
      if (!attemptsMap.has(key)) {
        attemptsMap.set(key, { ...data, _source: source });
      } else {
        // Merge, with runtime status taking precedence
        const existing = attemptsMap.get(key);
        attemptsMap.set(key, {
          ...existing,
          ...data,
          // Runtime status wins
          status: source === 'runtime' ? data.status : existing.status,
          // Fill in missing fields
          outcome: data.outcome || existing.outcome,
          model: data.model || existing.model,
          startedAt: data.startedAt || existing.startedAt,
          completedAt: data.completedAt || existing.completedAt,
          queuedAt: data.queuedAt || existing.queuedAt,
          _source: source === 'runtime' ? source : existing._source
        });
      }
    };
    
    // Add runtime entries (these are authoritative for status)
    runtimeRunning.forEach(r => {
      const key = r.sessionKey || r.sessionLabel || `running-${r.taskId}`;
      addAttempt(key, {
        taskId: r.taskId,
        sessionKey: r.sessionKey,
        sessionLabel: r.sessionLabel,
        status: 'running',
        model: r.model,
        startedAt: r.startedAt,
        completedAt: null,
        queuedAt: null,
        outcome: null,
        tokensUsed: null
      }, 'runtime');
    });
    
    runtimeQueued.forEach(q => {
      const key = q.sessionLabel || `queued-${q.taskId}`;
      addAttempt(key, {
        taskId: q.taskId,
        sessionKey: null,
        sessionLabel: q.sessionLabel || null,
        status: 'queued',
        model: q.model,
        startedAt: null,
        completedAt: null,
        queuedAt: q.queuedAt,
        outcome: null,
        tokensUsed: null
      }, 'runtime');
    });
    
    runtimeCompleted.forEach(c => {
      const key = c.sessionKey || c.sessionLabel || `completed-${c.taskId}`;
      addAttempt(key, {
        taskId: c.taskId,
        sessionKey: c.sessionKey,
        sessionLabel: c.sessionLabel,
        status: 'completed',
        model: null,
        startedAt: c.startedAt,
        completedAt: c.completedAt,
        queuedAt: null,
        outcome: c.outcome,
        tokensUsed: null
      }, 'runtime');
    });
    
    // Try to enrich with gateway session data
    try {
      // Discover sessions within last 24 hours that match this task
      const sessions = await sessionsList({
        kinds: ['other'], // Subagents are typically categorized as 'other'
        activeMinutes: 1440, // 24 hours
        messageLimit: 0 // Don't fetch messages in list
      });
      
      // Filter sessions by displayName/label matching mosbot-task-{taskId}-
      const taskSessions = sessions.filter(s => {
        const displayName = s.displayName || s.sessionLabel || '';
        return displayName.startsWith(`mosbot-task-${id}-`) || 
               displayName.startsWith(`mosbot-task-${taskNumber}-`);
      });
      
      // Enrich attempts with gateway session data
      for (const session of taskSessions) {
        const key = session.key || session.sessionKey;
        if (!key) continue;
        
        // Map session status to normalized status
        let gatewayStatus = 'unknown';
        if (session.abortedLastRun === true) {
          gatewayStatus = 'failed';
        } else if (session.kind === 'other' && session.updatedAt) {
          // If we have a recent update and it's in gateway, assume running or completed
          gatewayStatus = 'running'; // Will be overridden by runtime if present
        }
        
        // Try to fetch history for outcome if not present
        let outcome = null;
        if (!attemptsMap.has(key) || !attemptsMap.get(key).outcome) {
          try {
            const history = await sessionsHistory({
              sessionKey: key,
              limit: 50,
              includeTools: false
            });
            
            // Find last assistant message as outcome
            for (let i = history.length - 1; i >= 0; i--) {
              const msg = history[i];
              if (msg.role === 'assistant' && msg.content) {
                const content = Array.isArray(msg.content) 
                  ? msg.content.map(c => c.text || '').join('\n')
                  : msg.content;
                if (content.trim()) {
                  outcome = content.trim();
                  break;
                }
              }
            }
          } catch (histErr) {
            logger.warn('Failed to fetch session history', { sessionKey: key, error: histErr.message });
          }
        }
        
        addAttempt(key, {
          taskId: id,
          sessionKey: key,
          sessionLabel: session.displayName || session.sessionLabel,
          status: gatewayStatus,
          model: session.model,
          startedAt: null, // Runtime provides more accurate startedAt
          completedAt: null,
          queuedAt: null,
          outcome,
          tokensUsed: session.totalTokens || null
        }, 'gateway');
      }
    } catch (gatewayErr) {
      // Gateway not available - gracefully degrade
      logger.warn('OpenClaw gateway not available for session enrichment', { 
        error: gatewayErr.message,
        code: gatewayErr.code
      });
    }
    
    // Convert map to array and sort by newest first
    const attempts = Array.from(attemptsMap.values())
      .map(a => {
        // Clean up internal fields
        delete a._source;
        return a;
      })
      .sort((a, b) => {
        const aTime = new Date(a.startedAt || a.queuedAt || a.completedAt || 0).getTime();
        const bTime = new Date(b.startedAt || b.queuedAt || b.completedAt || 0).getTime();
        return bTime - aTime; // Newest first
      });
    
    // Calculate meta counts
    const meta = {
      total: attempts.length,
      running: attempts.filter(a => a.status === 'running').length,
      completed: attempts.filter(a => a.status === 'completed').length,
      failed: attempts.filter(a => a.status === 'failed').length,
      queued: attempts.filter(a => a.status === 'queued').length
    };
    
    res.json({ data: attempts, meta });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
