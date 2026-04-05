// ============================================================
// SOMA API — Goal Routes
// GET   /goals
// POST  /goals
// PATCH /goals/:id
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');

let _config = {};
try { _config = require('../../../soma.config.js'); } catch (_) {}
const DATA_DIR = process.env.SOMA_DATA || _config.dataDir || path.join(__dirname, '../../../data');
const GOALS_FILE = path.join(DATA_DIR, 'goals.json');

module.exports = function goalRoutes(engine) {
  const router = express.Router();

  // GET /goals — list goals filtered by status
  router.get('/goals', (req, res) => {
    try {
      const { status, horizon } = req.query;
      let goals = engine.goals || [];

      if (status) goals = goals.filter(g => g.status === status);
      if (horizon) goals = goals.filter(g => g.horizon === horizon);

      res.json({ goals, total: goals.length });
    } catch (err) {
      res.status(500).json({ error: { code: 'GOALS_ERROR', message: err.message } });
    }
  });

  // POST /goals — create a new goal
  router.post('/goals', (req, res) => {
    try {
      const goalData = req.body || {};
      if (!goalData.title) {
        return res.status(400).json({ error: { code: 'MISSING_TITLE', message: '"title" required.' } });
      }

      // Use engine.addGoal if it exists (we add it in Step 7)
      if (typeof engine.addGoal === 'function') {
        const goal = engine.addGoal(goalData);
        return res.status(201).json({ goal });
      }

      // Fallback: write directly to goals.json + update in-memory
      const goal = {
        id: `g-${Date.now()}`,
        title: goalData.title,
        description: goalData.description || '',
        status: goalData.status || 'active',
        horizon: goalData.horizon || 'medium',
        tags: goalData.tags || [],
        created: Date.now(),
        ...goalData
      };

      let goals = [];
      try { goals = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8')); } catch (_) {}
      if (!Array.isArray(goals)) goals = [];
      goals.push(goal);
      fs.writeFileSync(GOALS_FILE, JSON.stringify(goals, null, 2));

      engine.goals = goals;
      engine.context.activeGoals = goals.filter(g => g.status === 'active');

      res.status(201).json({ goal });
    } catch (err) {
      res.status(500).json({ error: { code: 'GOAL_CREATE_ERROR', message: err.message } });
    }
  });

  // PATCH /goals/:id — update a goal
  router.patch('/goals/:id', (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body || {};

      let goals = engine.goals || [];
      const idx = goals.findIndex(g => g.id === id);
      if (idx === -1) {
        return res.status(404).json({ error: { code: 'GOAL_NOT_FOUND', message: `Goal ${id} not found` } });
      }

      goals[idx] = { ...goals[idx], ...updates, id, updated: Date.now() };

      // Persist
      try { fs.writeFileSync(GOALS_FILE, JSON.stringify(goals, null, 2)); } catch (_) {}

      // Update in-memory
      engine.goals = goals;
      engine.context.activeGoals = goals.filter(g => g.status === 'active');

      res.json({ goal: goals[idx] });
    } catch (err) {
      res.status(500).json({ error: { code: 'GOAL_UPDATE_ERROR', message: err.message } });
    }
  });

  return router;
};
