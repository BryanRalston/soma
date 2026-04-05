// ============================================================
// SOMA API — System Routes
// /health  (public)
// /status  (authenticated)
// /admin/reflect  (admin)
// /admin/save     (admin)
// ============================================================

const express = require('express');
const { requireAdmin } = require('../auth');
const { version } = require('../../../package.json');

module.exports = function systemRoutes(engine) {
  const router = express.Router();

  // GET /health — public, no auth
  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      version: version || '0.1.0',
      uptime: process.uptime()
    });
  });

  // GET /status — engine status snapshot
  router.get('/status', (req, res) => {
    try {
      const status = engine.status();
      const sessionLock = require('../../tools/session-lock');
      const sessions = sessionLock.getActiveSessions();
      res.json({
        ...status,
        sessions,
        pid: process.pid
      });
    } catch (err) {
      res.status(500).json({ error: { code: 'STATUS_ERROR', message: err.message } });
    }
  });

  // POST /admin/reflect — trigger one reflection cycle
  router.post('/admin/reflect', requireAdmin, async (req, res) => {
    try {
      const cycle = await engine.reflect();
      res.json({
        cycleId: cycle.id,
        elapsed: cycle.elapsed,
        action: cycle.phases?.act?.action,
        source: cycle.phases?.act?.source,
        output: cycle.phases?.act?.output
      });
    } catch (err) {
      res.status(500).json({ error: { code: 'REFLECT_ERROR', message: err.message } });
    }
  });

  // POST /admin/save — persist knowledge graph
  router.post('/admin/save', requireAdmin, (req, res) => {
    try {
      engine.save();
      res.json({ saved: true, nodes: engine.kg.nodes.size, edges: engine.kg.edges.size });
    } catch (err) {
      res.status(500).json({ error: { code: 'SAVE_ERROR', message: err.message } });
    }
  });

  return router;
};
