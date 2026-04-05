// ============================================================
// SOMA API — Auth Middleware
// API key auth: Bearer token or admin key header.
// ============================================================

let _config = {};
try { _config = require('../../soma.config.js'); } catch (_) {}

const ADMIN_KEY = _config.adminKey || process.env.SOMA_ADMIN_KEY || null;
const API_KEYS = _config.apiKeys || [];   // [{ key, name, userId, scopes }]
const PUBLIC_PATHS = new Set(['/api/v1/health']);

// ── Lookup helpers ───────────────────────────────────────────

function lookupApiKey(token) {
  if (!token) return null;
  return API_KEYS.find(k => k.key === token) || null;
}

function isAdminKey(token) {
  if (!ADMIN_KEY || !token) return false;
  return token === ADMIN_KEY;
}

// ── Middleware factories ─────────────────────────────────────

/**
 * requireApiKey — 401 if no valid Bearer token or admin key.
 * Attaches req.auth = { userId, name, scopes, isAdmin }.
 */
function requireApiKey(req, res, next) {
  // Admin key via X-Soma-Admin-Key header
  const adminHeader = req.headers['x-soma-admin-key'];
  if (adminHeader && isAdminKey(adminHeader)) {
    req.auth = { userId: 'admin', name: 'admin', scopes: ['*'], isAdmin: true };
    return next();
  }

  // Bearer token
  const authHeader = req.headers['authorization'] || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1] : null;

  // Admin key can also be used as Bearer
  if (token && isAdminKey(token)) {
    req.auth = { userId: 'admin', name: 'admin', scopes: ['*'], isAdmin: true };
    return next();
  }

  const keyEntry = lookupApiKey(token);
  if (keyEntry) {
    req.auth = {
      userId: keyEntry.userId || 'api',
      name: keyEntry.name || 'api-key',
      scopes: keyEntry.scopes || ['*'],
      isAdmin: false
    };
    return next();
  }

  // No valid key — but allow if no keys are configured at all (open mode)
  if (!ADMIN_KEY && API_KEYS.length === 0) {
    req.auth = { userId: 'local', name: 'local', scopes: ['*'], isAdmin: false };
    return next();
  }

  res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Valid API key required.' } });
}

/**
 * requireAdmin — 401 if not admin key.
 */
function requireAdmin(req, res, next) {
  const adminHeader = req.headers['x-soma-admin-key'];
  const authHeader = req.headers['authorization'] || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1] : null;

  if ((adminHeader && isAdminKey(adminHeader)) || (token && isAdminKey(token))) {
    req.auth = { userId: 'admin', name: 'admin', scopes: ['*'], isAdmin: true };
    return next();
  }

  // Already attached from requireApiKey as admin?
  if (req.auth?.isAdmin) return next();

  // Check if they have a valid (non-admin) API key — 403 if so, 401 if not
  const hasValidApiKey = !!lookupApiKey(token);
  const status = hasValidApiKey ? 403 : 401;
  const code = hasValidApiKey ? 'FORBIDDEN' : 'ADMIN_REQUIRED';
  res.status(status).json({ error: { code, message: 'Admin key required.' } });
}

/**
 * optionalAuth — attaches key info if present, doesn't block.
 */
function optionalAuth(req, res, next) {
  const adminHeader = req.headers['x-soma-admin-key'];
  if (adminHeader && isAdminKey(adminHeader)) {
    req.auth = { userId: 'admin', name: 'admin', scopes: ['*'], isAdmin: true };
    return next();
  }

  const authHeader = req.headers['authorization'] || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1] : null;

  if (token && isAdminKey(token)) {
    req.auth = { userId: 'admin', name: 'admin', scopes: ['*'], isAdmin: true };
    return next();
  }

  const keyEntry = lookupApiKey(token);
  if (keyEntry) {
    req.auth = {
      userId: keyEntry.userId || 'api',
      name: keyEntry.name || 'api-key',
      scopes: keyEntry.scopes || ['*'],
      isAdmin: false
    };
  }

  // No key found — no auth attached, but not blocked
  next();
}

module.exports = { requireApiKey, requireAdmin, optionalAuth };
