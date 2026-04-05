// ============================================================
// SOMA API — Session Routes
// POST   /sessions           register + get briefing
// DELETE /sessions/:id       unregister + consolidate
// PATCH  /sessions/:id/heartbeat  update lastSeen
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const sessionLock = require('../../tools/session-lock');

let _config = {};
try { _config = require('../../../soma.config.js'); } catch (_) {}
const DATA_DIR = process.env.SOMA_DATA || _config.dataDir || path.join(__dirname, '../../../data');
const NARRATIVES_FILE = path.join(DATA_DIR, 'session_narratives.json');

module.exports = function sessionRoutes(engine) {
  const router = express.Router();

  // POST /sessions — register a new user session
  router.post('/sessions', async (req, res) => {
    try {
      const { project, pid } = req.body || {};
      const id = `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const session = sessionLock.registerSession(id, pid || process.pid, project || 'unknown');

      // Generate briefing alongside registration
      let briefing = null;
      try {
        if (engine.briefing) {
          briefing = engine.briefing.generate();
        }
      } catch (bErr) {
        briefing = { error: bErr.message };
      }

      res.status(201).json({ session, briefing });
    } catch (err) {
      res.status(500).json({ error: { code: 'SESSION_CREATE_ERROR', message: err.message } });
    }
  });

  // DELETE /sessions/:id — unregister + trigger consolidation
  router.delete('/sessions/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { narrative } = req.body || {};

      // Write narrative to session_narratives.json if provided
      if (narrative && typeof narrative === 'object') {
        try {
          const entry = {
            id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            sessionId: id,
            timestamp: Date.now(),
            ...narrative
          };
          let narratives = [];
          try {
            narratives = JSON.parse(fs.readFileSync(NARRATIVES_FILE, 'utf8'));
          } catch (_) {}
          if (!Array.isArray(narratives)) narratives = [];
          narratives.push(entry);
          fs.writeFileSync(NARRATIVES_FILE, JSON.stringify(narratives, null, 2));
        } catch (nErr) {
          console.warn('[Soma API] Narrative write failed:', nErr.message);
        }
      }

      const removed = sessionLock.unregisterSession(id);

      // Trigger consolidation async — don't block the response
      if (engine.consolidator) {
        setImmediate(() => {
          try { engine.consolidator.processNewSessions(); } catch (_) {}
        });
      }

      res.json({ removed, id });
    } catch (err) {
      res.status(500).json({ error: { code: 'SESSION_DELETE_ERROR', message: err.message } });
    }
  });

  // PATCH /sessions/:id/heartbeat — update lastSeen
  router.patch('/sessions/:id/heartbeat', (req, res) => {
    try {
      const { id } = req.params;
      const updated = sessionLock.updateSession(id, { lastSeen: Date.now() });

      if (!updated) {
        return res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: `Session ${id} not found` } });
      }

      // Return any undelivered notifications
      const since = req.body?.since || 0;
      const notifications = sessionLock.getNotifications(since);

      res.json({ id, lastSeen: Date.now(), notifications });
    } catch (err) {
      res.status(500).json({ error: { code: 'HEARTBEAT_ERROR', message: err.message } });
    }
  });

  return router;
};
