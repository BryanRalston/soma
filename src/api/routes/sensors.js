// ============================================================
// SOMA API — Sensor Routes
// GET  /sensors
// POST /sensors/:name/run  (admin)
// ============================================================

const express = require('express');
const { requireAdmin } = require('../auth');

module.exports = function sensorRoutes(engine) {
  const router = express.Router();

  // GET /sensors — self-report from sensor manager
  router.get('/sensors', (req, res) => {
    try {
      if (!engine.sensors) {
        return res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'Sensor system not initialized.' } });
      }

      const report = engine.sensors.selfReport();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: { code: 'SENSORS_ERROR', message: err.message } });
    }
  });

  // POST /sensors/:name/run — admin: force-run a specific sensor
  router.post('/sensors/:name/run', requireAdmin, async (req, res) => {
    try {
      if (!engine.sensors) {
        return res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'Sensor system not initialized.' } });
      }

      const sensor = engine.sensors.getSensor(req.params.name);
      if (!sensor) {
        return res.status(404).json({ error: { code: 'SENSOR_NOT_FOUND', message: `Sensor "${req.params.name}" not registered.` } });
      }

      const items = await sensor.run();
      let ingested = [];
      if (items && items.length > 0) {
        ingested = await engine.sensors.intake.ingest(req.params.name, items);
      }

      // Save state after manual run
      await engine.sensors.saveState();

      res.json({
        sensor: req.params.name,
        fetched: items?.length || 0,
        ingested: ingested.length
      });
    } catch (err) {
      res.status(500).json({ error: { code: 'SENSOR_RUN_ERROR', message: err.message } });
    }
  });

  return router;
};
