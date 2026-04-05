// ============================================================
// SOMA API — Corrections + Learner Routes
// POST /corrections   apply a correction to a KG node
// GET  /learner       learner self-report
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');

let _config = {};
try { _config = require('../../../soma.config.js'); } catch (_) {}
const DATA_DIR = process.env.SOMA_DATA || _config.dataDir || path.join(__dirname, '../../../data');
const CORRECTIONS_FILE = path.join(DATA_DIR, 'corrections_log.json');

module.exports = function correctionRoutes(engine) {
  const router = express.Router();

  // POST /corrections — apply correction: lower confidence + log
  router.post('/corrections', (req, res) => {
    try {
      const correction = req.body || {};
      const { nodeId, originalBelief, evidence, correctionText, domain, newConfidence } = correction;

      if (!nodeId) {
        return res.status(400).json({ error: { code: 'MISSING_NODE_ID', message: '"nodeId" required.' } });
      }

      // Use engine.applyCorrection if it exists (we add it in Step 7)
      if (typeof engine.applyCorrection === 'function') {
        const result = engine.applyCorrection(correction);
        return res.status(201).json(result);
      }

      // Fallback: manual application
      const node = engine.kg.getNode(nodeId);
      if (!node) {
        return res.status(404).json({ error: { code: 'NODE_NOT_FOUND', message: `Node ${nodeId} not found` } });
      }

      // Reduce confidence
      const currentConf = node.metadata?.confidence || 0.7;
      const updatedConf = newConfidence != null ? newConfidence : Math.max(0.1, currentConf * 0.6);

      engine.kg.updateNode(nodeId, {
        metadata: { ...node.metadata, confidence: updatedConf, flagged: true, correctedAt: Date.now() }
      });

      // Log correction
      const entry = {
        id: `c-${Date.now()}`,
        nodeId,
        originalBelief: originalBelief || node.title,
        evidence: evidence || '',
        correction: correctionText || '',
        domain: domain || 'general',
        previousConfidence: currentConf,
        newConfidence: updatedConf,
        timestamp: Date.now(),
        appliedBy: req.auth?.userId || 'api'
      };

      let log = [];
      try { log = JSON.parse(fs.readFileSync(CORRECTIONS_FILE, 'utf8')); } catch (_) {}
      if (!Array.isArray(log)) log = [];
      log.push(entry);
      fs.writeFileSync(CORRECTIONS_FILE, JSON.stringify(log, null, 2));

      // Notify learner if available
      if (engine.learner && typeof engine.learner.recordDecision === 'function') {
        try {
          engine.learner.recordDecision(
            `correction:${nodeId}`,
            [{ type: 'correction', correction: entry }],
            'apply-correction',
            { success: true, timestamp: Date.now() }
          );
        } catch (_) {}
      }

      res.status(201).json({ correction: entry, updatedNode: engine.kg.getNode(nodeId) });
    } catch (err) {
      res.status(500).json({ error: { code: 'CORRECTION_ERROR', message: err.message } });
    }
  });

  // GET /learner — learner self-report
  router.get('/learner', (req, res) => {
    try {
      if (!engine.learner) {
        return res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'Learner not initialized.' } });
      }

      const report = typeof engine.learner.selfReport === 'function'
        ? engine.learner.selfReport()
        : { stats: engine.learner.stats, learnedRules: engine.learner.learnedRules?.length };

      res.json(report);
    } catch (err) {
      res.status(500).json({ error: { code: 'LEARNER_ERROR', message: err.message } });
    }
  });

  return router;
};
