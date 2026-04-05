// ============================================================
// SOMA API — Sleep Routes
// GET  /sleep/state
// POST /sleep/cycle  (admin)
// ============================================================

const express = require('express');
const { requireAdmin } = require('../auth');

module.exports = function sleepRoutes(engine) {
  const router = express.Router();

  // GET /sleep/state — current sleep state
  router.get('/sleep/state', (req, res) => {
    try {
      const sleepModule = require('../../layers/sleep');

      let state = null;
      if (typeof sleepModule.loadSleepState === 'function') {
        state = sleepModule.loadSleepState();
      } else {
        return res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'loadSleepState not exported from sleep module.' } });
      }

      res.json(state || { activeThreads: [], cycleCount: 0 });
    } catch (err) {
      res.status(500).json({ error: { code: 'SLEEP_STATE_ERROR', message: err.message } });
    }
  });

  // POST /sleep/cycle — trigger one sleep cycle (admin only)
  router.post('/sleep/cycle', requireAdmin, async (req, res) => {
    try {
      // Sleep cycle runs as a child process / separate script
      // We spawn it and report the result
      const { execFile } = require('child_process');
      const path = require('path');
      const sleepScript = path.join(__dirname, '../../../src/layers/sleep.js');

      const child = execFile(process.execPath, [sleepScript], { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) {
          return res.status(500).json({ error: { code: 'SLEEP_CYCLE_ERROR', message: err.message }, stderr });
        }
        res.json({ triggered: true, output: stdout.slice(0, 2000) });
      });

      // Don't respond twice
      child.on('error', () => {});
    } catch (err) {
      res.status(500).json({ error: { code: 'SLEEP_CYCLE_ERROR', message: err.message } });
    }
  });

  return router;
};
