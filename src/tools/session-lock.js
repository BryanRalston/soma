// ============================================================
// SESSION LOCK — Dual-layer session state system
// Layer 1: User session registry (multiple concurrent allowed)
// Layer 2: Background lock (mutually exclusive: soma / action-router)
// Shared by: server.js (user chat), daemon.js (Soma),
//            action-pipeline.js, ClaudeSession
// ============================================================

const fs = require('fs');
const path = require('path');

let _config = {};
try { _config = require('../../soma.config.js'); } catch (_) {}
const DATA_DIR = process.env.SOMA_DATA || _config.dataDir || path.join(__dirname, '../../data');
const LOCK_FILE = path.join(DATA_DIR, 'session_lock.json');
const DEFAULT_TTL = 10 * 60 * 1000; // 10 minutes auto-expire
const STALE_SESSION_MS = 10 * 60 * 1000; // 10 minutes = stale user session
const MAX_NOTIFICATIONS = 20;

// ── State management ────────────────────────────────────────

/**
 * Default empty state shape.
 */
function defaultState() {
  return {
    userSessions: [],
    backgroundLock: null,
    notifications: []
  };
}

/**
 * Read the full state file. Returns default state on any error.
 */
function readState() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return defaultState();
    const raw = fs.readFileSync(LOCK_FILE, 'utf8');
    const state = JSON.parse(raw);
    // Ensure all fields exist (upgrade from old format)
    if (!Array.isArray(state.userSessions)) state.userSessions = [];
    if (state.backgroundLock === undefined) state.backgroundLock = null;
    if (!Array.isArray(state.notifications)) state.notifications = [];
    return state;
  } catch (err) {
    console.log(`[SessionLock] Error reading state file: ${err.message} — returning defaults`);
    return defaultState();
  }
}

/**
 * Write the full state file atomically.
 * Uses write-to-temp + rename to prevent corruption if the process crashes mid-write.
 */
function _writeState(state) {
  const tmpFile = LOCK_FILE + '.tmp';
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmpFile, LOCK_FILE);
  } catch (err) {
    console.error(`[SessionLock] Failed to write state: ${err.message}`);
    // Clean up temp file if rename failed
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

// ── PID check ───────────────────────────────────────────────

/**
 * Check if a PID is still running.
 * Returns false if the process is dead (stale lock/session).
 */
function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process, EPERM = exists but no permission (still alive)
    return err.code === 'EPERM';
  }
}

// ── User Session Registry (Layer 1) ─────────────────────────

/**
 * Register a user session. Multiple allowed concurrently.
 * @param {string} id - Session identifier (e.g., "s-abc123")
 * @param {number} pid - Process ID of the user's Claude Code terminal
 * @param {string} project - Project context (e.g., "my-project", "my-app")
 * @returns {object} The registered session entry
 */
function registerSession(id, pid, project) {
  const state = readState();
  const now = Date.now();

  // Remove any existing entry with the same ID (re-register)
  state.userSessions = state.userSessions.filter(s => s.id !== id);

  const entry = {
    id,
    pid: pid || process.pid,
    project: project || 'unknown',
    started: now,
    lastSeen: now
  };

  state.userSessions.push(entry);
  _writeState(state);
  console.log(`[SessionLock] User session registered: ${id} (PID ${entry.pid}, project: ${entry.project})`);
  return entry;
}

/**
 * Unregister a user session by ID.
 * @param {string} id - Session identifier to remove
 * @returns {boolean} Whether a session was removed
 */
function unregisterSession(id) {
  const state = readState();
  const before = state.userSessions.length;
  state.userSessions = state.userSessions.filter(s => s.id !== id);
  const removed = state.userSessions.length < before;
  if (removed) {
    _writeState(state);
    console.log(`[SessionLock] User session unregistered: ${id}`);
  }
  return removed;
}

/**
 * Get all active (non-stale) user sessions.
 * Auto-cleans stale sessions: dead PIDs or lastSeen > 10 min ago.
 * @returns {Array} Active user sessions
 */
function getActiveSessions() {
  const state = readState();
  const now = Date.now();
  let cleaned = false;

  const active = state.userSessions.filter(s => {
    // Check PID alive
    if (s.pid && !isPidRunning(s.pid)) {
      console.log(`[SessionLock] Cleaning stale session ${s.id} — PID ${s.pid} is dead`);
      cleaned = true;
      return false;
    }
    // Check lastSeen freshness
    if (s.lastSeen && (now - s.lastSeen) > STALE_SESSION_MS) {
      console.log(`[SessionLock] Cleaning stale session ${s.id} — last seen ${Math.round((now - s.lastSeen) / 1000)}s ago`);
      cleaned = true;
      return false;
    }
    return true;
  });

  if (cleaned) {
    state.userSessions = active;
    _writeState(state);
  }

  return active;
}

/**
 * Check if any user sessions are active.
 * @returns {{ active: boolean, count: number }}
 */
function isUserActive() {
  const sessions = getActiveSessions();
  return { active: sessions.length > 0, count: sessions.length };
}

// ── Background Lock (Layer 2) ───────────────────────────────

/**
 * Acquire the exclusive background lock. Only one of soma/action-router at a time.
 * Also checks for active user sessions (background processes yield to users).
 * @param {string} holder - "soma" or "action-router"
 * @param {number} [ttl] - Time-to-live in ms (default 10 minutes)
 * @returns {{ acquired: boolean, reason?: string, blockedBy?: string }}
 */
function acquireBackgroundLock(holder, ttl = DEFAULT_TTL) {
  const state = readState();
  const now = Date.now();

  // Check for active user sessions — background yields to users
  const userStatus = isUserActive();
  if (userStatus.active) {
    return {
      acquired: false,
      reason: `${userStatus.count} user session(s) active — background processes yield`,
      blockedBy: 'user'
    };
  }

  // Check existing background lock
  if (state.backgroundLock) {
    const lock = state.backgroundLock;

    // Check expiry
    if (lock.expires && now > lock.expires) {
      console.log(`[SessionLock] Background lock expired (holder: ${lock.holder}, expired ${Math.round((now - lock.expires) / 1000)}s ago)`);
      state.backgroundLock = null;
      // Fall through to acquire
    }
    // Check if PID is still alive
    else if (lock.pid && !isPidRunning(lock.pid)) {
      console.log(`[SessionLock] Stale background lock — PID ${lock.pid} (${lock.holder}) is dead`);
      state.backgroundLock = null;
      // Fall through to acquire
    }
    // Same holder re-acquiring — extend TTL
    else if (lock.holder === holder) {
      state.backgroundLock = {
        holder,
        pid: process.pid,
        started: lock.started,
        expires: now + ttl
      };
      _writeState(state);
      return { acquired: true };
    }
    // Different holder — blocked
    else {
      return {
        acquired: false,
        reason: `Background lock held by ${lock.holder} (PID ${lock.pid}, started ${new Date(lock.started).toISOString()})`,
        blockedBy: lock.holder
      };
    }
  }

  // No existing lock (or it was cleaned) — acquire it
  state.backgroundLock = {
    holder,
    pid: process.pid,
    started: now,
    expires: now + ttl
  };
  _writeState(state);
  console.log(`[SessionLock] Background lock acquired by ${holder} (PID ${process.pid}, TTL ${Math.round(ttl / 1000)}s)`);
  return { acquired: true };
}

/**
 * Release the background lock.
 * @param {string} holder - Only release if current holder matches
 * @returns {boolean} Whether the lock was released
 */
function releaseBackgroundLock(holder) {
  const state = readState();

  if (!state.backgroundLock) return true; // Nothing to release

  if (holder && state.backgroundLock.holder !== holder) {
    console.log(`[SessionLock] Background release denied — held by ${state.backgroundLock.holder}, not ${holder}`);
    return false;
  }

  console.log(`[SessionLock] Background lock released by ${holder || 'force'}`);
  state.backgroundLock = null;
  _writeState(state);
  return true;
}

// ── Notifications ───────────────────────────────────────────

/**
 * Add a notification to the state (max 20, FIFO).
 * @param {string} source - Who is notifying ("soma", "action-router")
 * @param {string} message - Human-readable message
 * @param {string} type - Notification type ("throttled", "info", "warning", etc.)
 * @returns {object} The notification entry
 */
function addNotification(source, message, type) {
  const state = readState();
  const notification = {
    id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    source,
    message,
    type: type || 'info',
    timestamp: Date.now(),
    delivered: false
  };

  state.notifications.push(notification);

  // Enforce max size — drop oldest first
  while (state.notifications.length > MAX_NOTIFICATIONS) {
    state.notifications.shift();
  }

  _writeState(state);
  return notification;
}

/**
 * Get notifications since a timestamp, optionally mark as delivered.
 * @param {number} [since] - Only return notifications after this timestamp (default: 0 = all)
 * @returns {Array} Matching notifications
 */
function getNotifications(since) {
  const state = readState();
  const cutoff = since || 0;
  return state.notifications.filter(n => n.timestamp > cutoff);
}

/**
 * Mark all notifications as delivered.
 * @returns {number} Number of notifications marked
 */
function markNotificationsDelivered() {
  const state = readState();
  let count = 0;
  for (const n of state.notifications) {
    if (!n.delivered) {
      n.delivered = true;
      count++;
    }
  }
  if (count > 0) _writeState(state);
  return count;
}

// ── Legacy compatibility wrappers ───────────────────────────
// These map the old single-lock API to the new dual-layer system.
// Kept so nothing breaks during transition.

/**
 * @deprecated Use registerSession() or acquireBackgroundLock() instead.
 */
function acquireLock(holder, ttl = DEFAULT_TTL) {
  if (holder === 'user') {
    // User sessions now go to the registry, not a lock
    const id = `s-${Date.now()}-${process.pid}`;
    const entry = registerSession(id, process.pid, 'legacy');
    return { acquired: true, lock: entry };
  }
  // Background holders use the new exclusive lock
  const result = acquireBackgroundLock(holder, ttl);
  if (result.acquired) {
    const state = readState();
    return { acquired: true, lock: state.backgroundLock };
  }
  return { acquired: false, lock: null, reason: result.reason };
}

/**
 * @deprecated Use unregisterSession() or releaseBackgroundLock() instead.
 */
function releaseLock(holder) {
  if (holder === 'user') {
    // Unregister all user sessions with current PID
    const state = readState();
    const before = state.userSessions.length;
    state.userSessions = state.userSessions.filter(s => s.pid !== process.pid);
    if (state.userSessions.length < before) {
      _writeState(state);
      console.log(`[SessionLock] Legacy releaseLock('user') — removed ${before - state.userSessions.length} session(s) for PID ${process.pid}`);
    }
    return true;
  }
  return releaseBackgroundLock(holder);
}

/**
 * @deprecated Use readState() instead.
 */
function readLock() {
  const state = readState();
  // Return backgroundLock for backward compat (old code expects lock object or null)
  if (state.backgroundLock) {
    // Check expiry
    if (state.backgroundLock.expires && Date.now() > state.backgroundLock.expires) {
      releaseBackgroundLock(state.backgroundLock.holder);
      return null;
    }
    // Check PID alive
    if (state.backgroundLock.pid && !isPidRunning(state.backgroundLock.pid)) {
      releaseBackgroundLock(state.backgroundLock.holder);
      return null;
    }
    return state.backgroundLock;
  }
  // If no background lock but user sessions exist, return a synthetic lock for compat
  const userStatus = isUserActive();
  if (userStatus.active) {
    return { holder: 'user', pid: null, started: null, expires: null, userSessions: userStatus.count };
  }
  return null;
}

/**
 * @deprecated Use acquireBackgroundLock() + isUserActive() instead.
 */
function isLockedBy(holder) {
  // Check user sessions
  const userStatus = isUserActive();
  if (userStatus.active && holder !== 'user') {
    return {
      locked: true,
      heldBy: 'user',
      reason: `${userStatus.count} user session(s) active`
    };
  }

  // Check background lock
  const state = readState();
  if (state.backgroundLock) {
    const lock = state.backgroundLock;
    // Check expiry
    if (lock.expires && Date.now() > lock.expires) {
      releaseBackgroundLock(lock.holder);
      return { locked: false };
    }
    // Check PID alive
    if (lock.pid && !isPidRunning(lock.pid)) {
      releaseBackgroundLock(lock.holder);
      return { locked: false };
    }
    // Same holder = not blocked
    if (lock.holder === holder) return { locked: false };
    return {
      locked: true,
      heldBy: lock.holder,
      reason: `Background lock held by ${lock.holder} (PID ${lock.pid})`
    };
  }

  return { locked: false };
}

module.exports = {
  LOCK_FILE,
  DEFAULT_TTL,
  // New API
  readState,
  registerSession,
  unregisterSession,
  getActiveSessions,
  isUserActive,
  acquireBackgroundLock,
  releaseBackgroundLock,
  addNotification,
  getNotifications,
  markNotificationsDelivered,
  isPidRunning,
  // Legacy compatibility (deprecated)
  readLock,
  acquireLock,
  releaseLock,
  isLockedBy
};
