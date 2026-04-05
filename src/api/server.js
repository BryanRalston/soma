// ============================================================
// SOMA REST API — Server Entry Point
// Boots SomaEngine once, mounts all route handlers.
// Port: SOMA_API_PORT env var, or config.api.port, or 3001.
// ============================================================

const express = require('express');

let _config = {};
try { _config = require('../../soma.config.js'); } catch (_) {}

const PORT = parseInt(process.env.SOMA_API_PORT || _config.api?.port || 3001, 10);

// ── Boot Engine ──────────────────────────────────────────────

async function startServer() {
  console.log('[Soma API] Booting engine...');

  const { boot } = require('../core/index');
  const engine = await boot({ verbose: false });

  console.log('[Soma API] Engine ready.');

  // ── Express App ─────────────────────────────────────────────

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Make engine available to routes via app.locals
  app.locals.engine = engine;

  // ── Mount Routes ─────────────────────────────────────────────

  const { requireApiKey } = require('./auth');

  // Public — no auth
  app.use('/api/v1', require('./routes/system')(engine));

  // All other routes require valid API key
  app.use('/api/v1', requireApiKey);
  app.use('/api/v1', require('./routes/sessions')(engine));
  app.use('/api/v1', require('./routes/briefing')(engine));
  app.use('/api/v1', require('./routes/kg')(engine));
  app.use('/api/v1', require('./routes/insights')(engine));
  app.use('/api/v1', require('./routes/patterns')(engine));
  app.use('/api/v1', require('./routes/episodes')(engine));
  app.use('/api/v1', require('./routes/sleep')(engine));
  app.use('/api/v1', require('./routes/observations')(engine));
  app.use('/api/v1', require('./routes/sensors')(engine));
  app.use('/api/v1', require('./routes/goals')(engine));
  app.use('/api/v1', require('./routes/routing')(engine));
  app.use('/api/v1', require('./routes/corrections')(engine));

  // ── Global Error Handler ─────────────────────────────────────

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('[Soma API] Unhandled error:', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  });

  // 404 catch-all
  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route: ${req.method} ${req.path}` } });
  });

  // ── Listen ───────────────────────────────────────────────────

  app.listen(PORT, () => {
    console.log(`[Soma API] Listening on http://localhost:${PORT}/api/v1`);
    console.log(`[Soma API] Health: GET http://localhost:${PORT}/api/v1/health`);
  });

  // ── Graceful Shutdown ────────────────────────────────────────

  process.on('SIGINT', () => {
    console.log('\n[Soma API] Shutting down...');
    engine.save();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    engine.save();
    process.exit(0);
  });

  return app;
}

startServer().catch(err => {
  console.error('[Soma API] Fatal boot error:', err);
  process.exit(1);
});
