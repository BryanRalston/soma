// ============================================================
// SOMA API — Routing / Query Routes
// POST /route         classify + route input
// POST /query         engine.query() — full OODA cycle
// GET  /route/stats   routing stats
// ============================================================

const express = require('express');

module.exports = function routingRoutes(engine) {
  const router = express.Router();

  // POST /route — classify input and get routing decision
  router.post('/route', (req, res) => {
    try {
      const { input } = req.body || {};
      if (!input || typeof input !== 'string') {
        return res.status(400).json({ error: { code: 'MISSING_INPUT', message: '"input" string required.' } });
      }

      if (!engine.router) {
        return res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'Router not initialized.' } });
      }

      const decision = engine.router.route(input);
      res.json(decision);
    } catch (err) {
      res.status(500).json({ error: { code: 'ROUTE_ERROR', message: err.message } });
    }
  });

  // POST /query — full engine query (OODA cycle)
  router.post('/query', async (req, res) => {
    try {
      const { input } = req.body || {};
      if (!input || typeof input !== 'string') {
        return res.status(400).json({ error: { code: 'MISSING_INPUT', message: '"input" string required.' } });
      }

      const cycle = await engine.query(input);
      res.json({
        cycleId: cycle.id,
        elapsed: cycle.elapsed,
        action: cycle.phases?.act?.action,
        source: cycle.phases?.act?.source,
        output: cycle.phases?.act?.output
      });
    } catch (err) {
      if (err.message?.includes('not implemented')) {
        return res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: err.message } });
      }
      res.status(500).json({ error: { code: 'QUERY_ERROR', message: err.message } });
    }
  });

  // GET /route/stats — router statistics
  router.get('/route/stats', (req, res) => {
    try {
      if (!engine.router) {
        return res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'Router not initialized.' } });
      }

      const report = typeof engine.router.selfReport === 'function'
        ? engine.router.selfReport()
        : engine.router.stats;

      res.json(report);
    } catch (err) {
      res.status(500).json({ error: { code: 'ROUTE_STATS_ERROR', message: err.message } });
    }
  });

  return router;
};
