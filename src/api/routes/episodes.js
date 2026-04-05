// ============================================================
// SOMA API — Episode Routes
// GET  /episodes
// POST /episodes
// GET  /episodes/:id
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');

let _config = {};
try { _config = require('../../../soma.config.js'); } catch (_) {}
const DATA_DIR = process.env.SOMA_DATA || _config.dataDir || path.join(__dirname, '../../../data');
const NARRATIVES_FILE = path.join(DATA_DIR, 'session_narratives.json');

module.exports = function episodeRoutes(engine) {
  const router = express.Router();

  // GET /episodes — paginated episode list with optional filters
  router.get('/episodes', (req, res) => {
    try {
      if (!engine.consolidator) {
        return res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'Consolidator not initialized.' } });
      }

      const { project, limit = 20, offset = 0 } = req.query;
      let episodes = engine.consolidator.episodes || [];

      if (project) {
        episodes = episodes.filter(e => e.project === project);
      }

      // Sort by timestamp desc
      episodes = [...episodes].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      const total = episodes.length;
      const page = episodes.slice(parseInt(offset), parseInt(offset) + parseInt(limit));

      res.json({ episodes: page, total, offset: parseInt(offset), limit: parseInt(limit) });
    } catch (err) {
      res.status(500).json({ error: { code: 'EPISODES_ERROR', message: err.message } });
    }
  });

  // POST /episodes — write narrative + trigger consolidation
  router.post('/episodes', async (req, res) => {
    try {
      const narrative = req.body;
      if (!narrative || typeof narrative !== 'object') {
        return res.status(400).json({ error: { code: 'INVALID_BODY', message: 'Narrative object required.' } });
      }

      const entry = {
        id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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

      // Trigger consolidation (async — don't block)
      let consolidationResult = null;
      if (engine.consolidator) {
        try {
          consolidationResult = engine.consolidator.processNewSessions();
        } catch (cErr) {
          consolidationResult = { error: cErr.message };
        }
      }

      res.status(201).json({ narrative: entry, consolidation: consolidationResult });
    } catch (err) {
      res.status(500).json({ error: { code: 'EPISODE_CREATE_ERROR', message: err.message } });
    }
  });

  // GET /episodes/:id — single episode with KG node + neighbors
  router.get('/episodes/:id', (req, res) => {
    try {
      if (!engine.consolidator) {
        return res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'Consolidator not initialized.' } });
      }

      const episode = (engine.consolidator.episodes || []).find(e => e.id === req.params.id);
      if (!episode) {
        return res.status(404).json({ error: { code: 'EPISODE_NOT_FOUND', message: `Episode ${req.params.id} not found` } });
      }

      let kgNode = null;
      let neighbors = [];
      try {
        kgNode = engine.kg.getNode(req.params.id);
        if (kgNode) {
          neighbors = engine.kg.neighbors(req.params.id, 'both');
        }
      } catch (_) {}

      res.json({ episode, kgNode, neighbors });
    } catch (err) {
      res.status(500).json({ error: { code: 'EPISODE_GET_ERROR', message: err.message } });
    }
  });

  return router;
};
