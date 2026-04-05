// ============================================================
// SOMA API — Briefing Routes
// GET /briefing   full briefing
// GET /context    assembled cognitive context
// ============================================================

const express = require('express');

module.exports = function briefingRoutes(engine) {
  const router = express.Router();

  // GET /briefing — generate session briefing
  router.get('/briefing', (req, res) => {
    try {
      if (!engine.briefing) {
        return res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'Briefing system not initialized.' } });
      }

      // engine.briefing.generate() takes no params but filters internally by lastBriefing timestamp
      // The query params (format, since, sections) are used for filtering here in the handler
      const briefing = engine.briefing.generate();

      const { sections, format } = req.query;

      let result = briefing;

      // Filter sections if requested
      if (sections) {
        const wanted = sections.split(',').map(s => s.trim().toLowerCase());
        result = {
          ...briefing,
          sections: briefing.sections.filter(s =>
            wanted.some(w => (s.title || '').toLowerCase().includes(w))
          )
        };
      }

      // Text format: flatten to readable string
      if (format === 'text') {
        let text = `Soma Briefing — ${result.timeSince || 'unknown'} since last session\n\n`;
        for (const section of (result.sections || [])) {
          text += `## ${section.title}\n${section.summary}\n`;
          if (section.highlights?.length) {
            text += section.highlights.map(h => `  - ${h}`).join('\n') + '\n';
          }
          text += '\n';
        }
        return res.type('text/plain').send(text);
      }

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: { code: 'BRIEFING_ERROR', message: err.message } });
    }
  });

  // GET /context — assembled cognitive context snapshot
  router.get('/context', (req, res) => {
    try {
      const state = engine.self ? engine.self.currentState() : {};
      const activeGoals = (engine.goals || []).filter(g => g.status === 'active');
      const sessions = require('../../tools/session-lock').getActiveSessions();

      // Open questions: nodes in the KG with type 'question' or 'hypothesis'
      let openQuestions = [];
      try {
        openQuestions = engine.kg.query({ type: 'question' }).slice(0, 10)
          .concat(engine.kg.query({ type: 'hypothesis' }).slice(0, 5))
          .map(n => ({ id: n.id, title: n.title, confidence: n.metadata?.confidence }));
      } catch (_) {}

      res.json({
        self: state,
        activeGoals: activeGoals.map(g => ({ id: g.id, title: g.title, horizon: g.horizon })),
        activeSessions: sessions,
        openQuestions,
        context: engine.context || {}
      });
    } catch (err) {
      res.status(500).json({ error: { code: 'CONTEXT_ERROR', message: err.message } });
    }
  });

  return router;
};
