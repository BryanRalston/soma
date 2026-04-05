// ============================================================
// SOMA API — Pattern Routes
// GET /patterns
// GET /patterns/temporal
// ============================================================

const express = require('express');

module.exports = function patternRoutes(engine) {
  const router = express.Router();

  // GET /patterns — full pattern analysis
  router.get('/patterns', (req, res) => {
    try {
      const { windowDays = 30 } = req.query;
      const analysis = engine.patterns.analyze({ windowDays: parseInt(windowDays) });
      res.json(analysis);
    } catch (err) {
      if (err.message?.includes('not implemented')) {
        return res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: err.message } });
      }
      res.status(500).json({ error: { code: 'PATTERNS_ERROR', message: err.message } });
    }
  });

  // GET /patterns/temporal?tagA=<tag>&tagB=<tag>&hours=24
  router.get('/patterns/temporal', (req, res) => {
    try {
      const { tagA, tagB, hours = 24 } = req.query;
      if (!tagA || !tagB) {
        return res.status(400).json({ error: { code: 'MISSING_PARAMS', message: '"tagA" and "tagB" query params required.' } });
      }

      const result = engine.patterns.temporalCorrelation(tagA, tagB, parseInt(hours));
      res.json(result);
    } catch (err) {
      if (err.message?.includes('not implemented')) {
        return res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: err.message } });
      }
      res.status(500).json({ error: { code: 'TEMPORAL_ERROR', message: err.message } });
    }
  });

  return router;
};
