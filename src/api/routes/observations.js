// ============================================================
// SOMA API — Observation Routes
// POST /observations           ingest items
// GET  /observations/intake    inspect intake buffer
// POST /observations/intake/process  admin: flush buffer
// ============================================================

const express = require('express');
const { requireAdmin } = require('../auth');

module.exports = function observationRoutes(engine) {
  const router = express.Router();

  // POST /observations — normalize + ingest into intake buffer
  router.post('/observations', async (req, res) => {
    try {
      if (!engine.sensors) {
        return res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'Sensor system not initialized.' } });
      }

      const { source, items } = req.body || {};
      if (!source || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: { code: 'INVALID_BODY', message: '"source" string and "items" array required.' } });
      }

      // Normalize items to intake format if needed
      const normalized = items.map(item => {
        if (item.data && item.url) return item; // already intake format
        return {
          url: item.url || item.id || `obs-${Date.now()}-${Math.random().toString(36).slice(2, 4)}`,
          data: {
            title: item.title || 'Untitled observation',
            body: item.body || item.description || item.content || '',
            tags: item.tags || [],
            ...item
          },
          fetchedAt: Date.now()
        };
      });

      const ingested = await engine.sensors.intake.ingest(source, normalized);
      res.status(201).json({ ingested: ingested.length, total: normalized.length, source });
    } catch (err) {
      res.status(500).json({ error: { code: 'INGEST_ERROR', message: err.message } });
    }
  });

  // GET /observations/intake — inspect current intake buffer
  router.get('/observations/intake', (req, res) => {
    try {
      if (!engine.sensors?.intake) {
        return res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'Intake buffer not available.' } });
      }

      const { status } = req.query;
      let items = engine.sensors.intake.items || [];
      if (status) {
        items = items.filter(i => i.status === status);
      }

      const summary = engine.sensors.intake.summary ? engine.sensors.intake.summary() : { count: items.length };
      res.json({ summary, items: items.slice(0, 50) });
    } catch (err) {
      res.status(500).json({ error: { code: 'INTAKE_ERROR', message: err.message } });
    }
  });

  // POST /observations/intake/process — admin: flush + promote
  router.post('/observations/intake/process', requireAdmin, async (req, res) => {
    try {
      if (!engine.sensors) {
        return res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'Sensor system not initialized.' } });
      }

      const options = req.body || {};
      const result = await engine.sensors.processIntake(options);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: { code: 'PROCESS_INTAKE_ERROR', message: err.message } });
    }
  });

  return router;
};
