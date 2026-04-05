// ============================================================
// SOMA API — Insights Routes
// GET  /insights
// GET  /insights/contradictions
// POST /insights/infer
// GET  /insights/explain/:id
// ============================================================

const express = require('express');

module.exports = function insightsRoutes(engine) {
  const router = express.Router();

  // GET /insights — generate insights from reasoner
  router.get('/insights', (req, res) => {
    try {
      const insights = engine.reasoner.generateInsights();
      res.json({ insights, count: insights.length });
    } catch (err) {
      if (err.message?.includes('not implemented')) {
        return res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: err.message } });
      }
      res.status(500).json({ error: { code: 'INSIGHTS_ERROR', message: err.message } });
    }
  });

  // GET /insights/contradictions — find contradictory nodes
  router.get('/insights/contradictions', (req, res) => {
    try {
      const contradictions = engine.reasoner.findContradictions();
      res.json({ contradictions, count: contradictions.length });
    } catch (err) {
      if (err.message?.includes('not implemented')) {
        return res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: err.message } });
      }
      res.status(500).json({ error: { code: 'CONTRADICTIONS_ERROR', message: err.message } });
    }
  });

  // POST /insights/infer — run forward chaining
  router.post('/insights/infer', (req, res) => {
    try {
      const { maxIterations = 10 } = req.body || {};
      const conclusions = engine.reasoner.forwardChain(parseInt(maxIterations));
      res.json({
        conclusions,
        count: conclusions.length,
        newCount: conclusions._newCount ?? null,
        totalSeen: conclusions._totalSeen ?? null
      });
    } catch (err) {
      if (err.message?.includes('not implemented')) {
        return res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: err.message } });
      }
      res.status(500).json({ error: { code: 'INFER_ERROR', message: err.message } });
    }
  });

  // GET /insights/explain/:id — backward chaining explanation
  router.get('/insights/explain/:id', (req, res) => {
    try {
      const { maxDepth = 4 } = req.query;
      const explanation = engine.reasoner.explain(req.params.id, parseInt(maxDepth));
      if (!explanation) {
        return res.status(404).json({ error: { code: 'NODE_NOT_FOUND', message: `Node ${req.params.id} not found` } });
      }
      res.json({ explanation });
    } catch (err) {
      if (err.message?.includes('not implemented')) {
        return res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: err.message } });
      }
      res.status(500).json({ error: { code: 'EXPLAIN_ERROR', message: err.message } });
    }
  });

  return router;
};
