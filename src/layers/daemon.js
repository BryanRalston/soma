// ============================================================
// SOMA DAEMON
// Replaces thinking_loop.js. Runs continuously.
// The mind that doesn't sleep.
//
// Safety architecture (2026-03-16):
//   Layer 1: Graph processing — zero-token, every 60s, ALWAYS runs
//   Layer 2: Deep thinking — spawns claude.exe, EVENT-DRIVEN only
//     Gated by _safetyGateOpen() which requires ALL of:
//       - No active user sessions
//       - 30+ min since last user session ended
//       - System memory below 70%
//       - No claude.exe processes running
//     Fail-safe: if any check errors, assume UNSAFE
// ============================================================

const { SomaEngine } = require('../core/index');
const { ClaudeSession } = require('../tools/claude-session');
const { GrokSession } = require('../tools/grok-session');
const { isLockedBy, addNotification, getActiveSessions, readState } = require('../tools/session-lock');
const { runSleepCycle, loadSleepState } = require('./sleep');
const QuestionDetector = require('./question-detector');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execSync } = require('child_process');

let _config = {};
try { _config = require('../../soma.config.js'); } catch (_) {}

const SOMA_HOME = process.env.SOMA_HOME || _config.home || path.join(__dirname, '../..');
const DATA_DIR = process.env.SOMA_DATA || _config.dataDir || path.join(SOMA_HOME, 'data');

const SIGNALS_FILE = path.join(DATA_DIR, 'thinking_signals.json');
const LOG_FILE = path.join(DATA_DIR, 'soma_core_log.json');
const LOCK_FILE = path.join(DATA_DIR, 'session_lock.json');
const DAEMON_PID_FILE = path.join(DATA_DIR, 'daemon.pid');

// ── Single-instance guard ─────────────────────────────────────
// Write PID file on start, check for existing instance, clean up on exit.
(function enforceSingleInstance() {
  if (fs.existsSync(DAEMON_PID_FILE)) {
    const existingPid = parseInt(fs.readFileSync(DAEMON_PID_FILE, 'utf8').trim(), 10);
    if (existingPid && existingPid !== process.pid) {
      // Check if that process is actually alive
      try {
        process.kill(existingPid, 0); // signal 0 = existence check, no kill
        console.log(`[Soma] Already running (PID ${existingPid}). Exiting.`);
        process.exit(0);
      } catch (e) {
        // Process not found — stale lock, overwrite it
        console.log(`[Soma] Stale PID file (${existingPid} not running). Taking over.`);
      }
    }
  }
  fs.writeFileSync(DAEMON_PID_FILE, String(process.pid), 'utf8');
  const cleanup = () => { try { fs.unlinkSync(DAEMON_PID_FILE); } catch (_) {} };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
})();
const GOALS_FILE = path.join(DATA_DIR, 'goals.json');
const MODEL_USAGE_FILE = path.join(DATA_DIR, 'model_usage.json');
const SOMA_JOURNAL_JSON = path.join(DATA_DIR, 'soma_journal.json');
const SOMA_JOURNAL_MD = path.join(DATA_DIR, 'soma_journal.md');
const SLEEP_STATE_FILE = path.join(DATA_DIR, 'sleep_state.json');
const THOUGHTSTREAM_FILE = path.join(DATA_DIR, 'thoughtstream.json');
const JOURNAL_MAX_ENTRIES = 200;
const JOURNAL_MD_ENTRIES = 48;

// Model tier configuration
const DEEP_THINK_MODEL = process.env.SOMA_DEEP_MODEL || 'sonnet'; // upgrade to 'capybara' when available
const ROUTINE_MODEL = 'sonnet';

// Safety constants
const DEEP_THINK_COOLDOWN = 60 * 60 * 1000;      // 60 minutes between deep thinks (was 30)
const SESSION_END_BUFFER = 30 * 60 * 1000;        // 30 minutes after last user session
const MEMORY_THRESHOLD = 0.78;                     // 78% memory usage max — this machine's baseline is ~64%, need real headroom
const API_TIMEOUT = 2000;                          // 2s timeout for HTTP checks
const SLEEP_CYCLE_INTERVAL = 30 * 60 * 1000;       // 30 minutes between sleep cycles
const MAX_DEEP_THINKS_PER_DAY = 4;                 // Cap autonomous deep thinks at 4/day

// ── Question warmth estimation (module-level helper) ─────────
// Questions don't have live warmth scores. Estimate from pursuit
// count and age: recently-pursued questions stay warmer.
function _estimateQuestionWarmth(q) {
  const pursuitCount = q.pursuitCount || 0;
  const updatedTs = q.updated ? new Date(q.updated).getTime() : 0;
  const daysSinceUpdate = updatedTs > 0 ? (Date.now() - updatedTs) / 86400000 : 999;

  // Pursuit count boosts warmth: each pursuit adds 0.2, capped at 0.8
  const pursuitBoost = Math.min(0.8, pursuitCount * 0.2);
  // Recency: fresh questions start at 0.5, decay over 14 days
  const recencyBase = Math.max(0, 0.5 - (daysSinceUpdate / 28));
  return Math.max(0, Math.min(1, pursuitBoost + recencyBase));
}

class SomaDaemon {
  constructor(options = {}) {
    this.engine = null;
    this.interval = options.interval || 300000;      // Graph processing: every 5 min (was 60s)
    this.graphTimer = null;
    this.cycleCount = 0;
    this.log = [];

    // Session management
    this.claudeSession = null;      // Active Claude session (ClaudeSession instance)
    this.sessionHistory = [];        // Past session summaries
    this.maxSessionAge = 300000;     // 5 min max session lifetime
    this.pendingSignals = [];        // Signals from Axon (user session started, etc.)

    // Cycle overlap guard
    this.cycleRunning = false;

    // Goal injection — rotate through active goals each cycle
    this.lastGoalIndex = 0;

    // Safety tracking
    this.lastDeepThinkTime = 0;              // Timestamp of last completed deep think
    this.lastSessionEndTime = 0;             // Timestamp of last user session ending
    this.lastKnownSessionCount = 0;          // Track session count to detect endings
    this.deepThinkQueued = false;             // Whether a deep think is pending execution
    this.deepThinkCountToday = 0;            // How many deep thinks have run today
    this.deepThinkDayKey = '';               // YYYY-MM-DD of current count day

    // Sleep continuity
    this.lastSleepCycle = 0;                 // Timestamp of last sleep cycle run

    // Proactive notification deduplication — keyed by `${type}:${subject}`, value = timestamp
    // Prune entries older than 2 hours before each check.
    this._recentNotifications = new Map();

    // Thread warmth tracking for cold-drop detection — keyed by thread title/id, value = warmth (0-1)
    this._previousThreadWarmth = new Map();
  }

  async start() {
    console.log('[Soma] Starting...');

    // Boot engine
    this.engine = new SomaEngine({ verbose: true });
    await this.engine.initialize();

    // Initialize session tracking state
    await this._initSessionTracking();

    // Layer 1 ONLY: Graph processing (lightweight, frequent)
    // Deep thinking is event-driven — triggered from graphCycle() when conditions are met
    this.graphTimer = setInterval(() => this.graphCycle(), this.interval);

    // Run immediately
    await this.graphCycle();

    // Initial sleep cycle to warm up thread state
    this._runSleepCycle();

    console.log(`[Soma] Running (graph: ${this.interval / 1000}s, deep think: event-driven with safety gate, sleep: every 30min)`);

    // Graceful shutdown
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  // ── Session Lifecycle Tracking ──────────────────────────────

  /**
   * Initialize session tracking by reading current state.
   * If sessions are already active, note their count so we detect when they end.
   */
  async _initSessionTracking() {
    try {
      const sessions = this._getActiveSessionsDirect();
      this.lastKnownSessionCount = sessions.length;
      if (sessions.length > 0) {
        console.log(`[Soma] ${sessions.length} active user session(s) detected at start — deep think suppressed until 30min after they end`);
      } else {
        // No active sessions, but we don't know when the last one ended.
        // Be conservative: assume one just ended.
        this.lastSessionEndTime = Date.now();
        console.log(`[Soma] No active user sessions — cooldown starts from now`);
      }
    } catch (err) {
      // Fail safe: assume a session just ended
      this.lastSessionEndTime = Date.now();
      this.lastKnownSessionCount = 0;
      console.log(`[Soma] Session tracking init error (${err.message}) — assuming recent activity`);
    }
  }

  /**
   * Poll session state and detect when user sessions end.
   * Called every graph cycle (60s).
   */
  _trackSessionLifecycle() {
    try {
      const sessions = this._getActiveSessionsDirect();
      const currentCount = sessions.length;

      // Detect session endings: count decreased
      if (currentCount < this.lastKnownSessionCount) {
        this.lastSessionEndTime = Date.now();
        const ended = this.lastKnownSessionCount - currentCount;
        console.log(`[Soma] ${ended} user session(s) ended — cooldown restarted (30min)`);
      }

      // Log new sessions appearing
      if (currentCount > this.lastKnownSessionCount) {
        const started = currentCount - this.lastKnownSessionCount;
        console.log(`[Soma] ${started} new user session(s) detected — deep think blocked`);
      }

      this.lastKnownSessionCount = currentCount;
    } catch (err) {
      // Fail safe: don't update, keep existing state
      console.error(`[Soma] Session tracking error: ${err.message}`);
    }
  }

  /**
   * Read active sessions directly from the lock file (no HTTP needed).
   * Falls back to empty array on error (fail-safe handled by caller).
   */
  _getActiveSessionsDirect() {
    try {
      // Use the session-lock module directly — it handles stale cleanup
      return getActiveSessions();
    } catch {
      return [];
    }
  }

  // ── Safety Gate ─────────────────────────────────────────────

  /**
   * The hard safety gate. Returns true ONLY when ALL conditions pass.
   * Any error in any check = fail safe (return false).
   * Logs every check result for debugging.
   */
  _safetyGateOpen() {
    const results = {
      noActiveSessions: false,
      sessionCooldownPassed: false,
      memoryBelowThreshold: false,
      noClaudeProcesses: false,
      deepThinkCooldownPassed: false
    };

    // 1. No active user sessions
    try {
      const sessions = this._checkActiveSessionsViaAPI();
      results.noActiveSessions = (sessions.count === 0);
      if (!results.noActiveSessions) {
        console.log(`[SafetyGate] BLOCKED: ${sessions.count} active user session(s)`);
        return false;
      }
    } catch (err) {
      // Fail safe: assume user IS active
      console.log(`[SafetyGate] BLOCKED: Session check failed (${err.message}) — assuming user active`);
      return false;
    }

    // 2. Last user session ended 30+ minutes ago
    if (this.lastSessionEndTime > 0) {
      const elapsed = Date.now() - this.lastSessionEndTime;
      results.sessionCooldownPassed = (elapsed >= SESSION_END_BUFFER);
      if (!results.sessionCooldownPassed) {
        const remainMin = ((SESSION_END_BUFFER - elapsed) / 60000).toFixed(1);
        console.log(`[SafetyGate] BLOCKED: User session ended ${(elapsed / 60000).toFixed(1)}min ago — need ${remainMin}min more`);
        return false;
      }
    } else {
      // Never seen a session end — only safe if no sessions exist in lock file
      results.sessionCooldownPassed = true;
    }

    // 3. System memory — require at least 900MB free (absolute, not percentage)
    // Percentage thresholds don't work on this machine — baseline is ~90% used.
    const MIN_FREE_MB = 900;
    try {
      const freeMem = os.freemem();
      const freeMB = freeMem / (1024 * 1024);
      results.memoryBelowThreshold = (freeMB >= MIN_FREE_MB);
      if (!results.memoryBelowThreshold) {
        console.log(`[SafetyGate] BLOCKED: Only ${freeMB.toFixed(0)}MB free (need ${MIN_FREE_MB}MB)`);
        return false;
      }
    } catch (err) {
      // Fail safe: assume high memory
      console.log(`[SafetyGate] BLOCKED: Memory check failed (${err.message}) — assuming high usage`);
      return false;
    }

    // 4. No claude.exe processes running
    try {
      const claudeRunning = this._isClaudeExeRunning();
      results.noClaudeProcesses = !claudeRunning;
      if (!results.noClaudeProcesses) {
        console.log(`[SafetyGate] BLOCKED: claude.exe process(es) detected`);
        return false;
      }
    } catch (err) {
      // Fail safe: assume claude IS running
      console.log(`[SafetyGate] BLOCKED: Process check failed (${err.message}) — assuming claude.exe running`);
      return false;
    }

    // 5. Deep think cooldown (30 minutes between deep thinks)
    if (this.lastDeepThinkTime > 0) {
      const elapsed = Date.now() - this.lastDeepThinkTime;
      results.deepThinkCooldownPassed = (elapsed >= DEEP_THINK_COOLDOWN);
      if (!results.deepThinkCooldownPassed) {
        const remainMin = ((DEEP_THINK_COOLDOWN - elapsed) / 60000).toFixed(1);
        console.log(`[SafetyGate] BLOCKED: Last deep think was ${(elapsed / 60000).toFixed(1)}min ago — need ${remainMin}min more`);
        return false;
      }
    } else {
      results.deepThinkCooldownPassed = true;
    }

    console.log(`[SafetyGate] ALL CLEAR — gate open`, JSON.stringify(results));
    return true;
  }

  // ── Model Tier Budget Check ───────────────────────────────

  /**
   * Read model_usage.json and check remaining budget for a tier.
   * Auto-resets daily/weekly counters if the day/week has rolled over.
   * Returns { allowed, remaining, tier, fallbackTier? }
   */
  _checkModelBudget(tier) {
    try {
      if (!fs.existsSync(MODEL_USAGE_FILE)) {
        // No usage file — allow by default (no tracking yet)
        return { allowed: true, remaining: Infinity, tier };
      }

      const usage = JSON.parse(fs.readFileSync(MODEL_USAGE_FILE, 'utf8'));
      const tierData = usage.tiers?.[tier];
      if (!tierData) {
        // Tier not defined — allow by default
        return { allowed: true, remaining: Infinity, tier };
      }

      // Auto-reset daily counters if day rolled over
      const now = new Date();
      const today = now.toISOString().split('T')[0];
      const lastReset = tierData.lastReset ? tierData.lastReset.split('T')[0] : null;
      if (lastReset !== today) {
        tierData.todayInputTokens = 0;
        tierData.todayOutputTokens = 0;
        // Reset weekly counters on Monday
        if (now.getDay() === 1 && lastReset !== today) {
          tierData.weekInputTokens = 0;
          tierData.weekOutputTokens = 0;
        }
        tierData.lastReset = now.toISOString();
        fs.writeFileSync(MODEL_USAGE_FILE, JSON.stringify(usage, null, 2));
      }

      const dailyUsed = (tierData.todayInputTokens || 0) + (tierData.todayOutputTokens || 0);
      const dailyBudget = tierData.dailyBudgetTokens || Infinity;
      const weeklyUsed = (tierData.weekInputTokens || 0) + (tierData.weekOutputTokens || 0);
      const weeklyBudget = tierData.weeklyBudgetTokens || Infinity;

      const dailyRemaining = dailyBudget - dailyUsed;
      const weeklyRemaining = weeklyBudget - weeklyUsed;
      const remaining = Math.min(dailyRemaining, weeklyRemaining);

      if (remaining <= 0) {
        return { allowed: false, remaining: 0, tier, reason: `${tier} budget exhausted (daily: ${dailyUsed}/${dailyBudget}, weekly: ${weeklyUsed}/${weeklyBudget})` };
      }

      // Budget gate: don't burn strategic tier budget in daemon cycles
      // If daily input tokens are at 90%+ of budget, warn and signal near-exhaustion
      const todayInputTokens = tierData.todayInputTokens || 0;
      const nearBudget = dailyBudget !== Infinity && todayInputTokens >= dailyBudget * 0.9;
      if (nearBudget) {
        console.warn(`[Budget] WARNING: ${tier} tier at ${((todayInputTokens / dailyBudget) * 100).toFixed(0)}% of daily budget — falling back to operational tier`);
        return { allowed: false, remaining, tier, reason: `${tier} near daily budget limit (${todayInputTokens}/${dailyBudget} input tokens, 90% threshold)`, nearBudget: true };
      }

      return { allowed: true, remaining, tier };
    } catch (err) {
      // If we can't read usage, allow the call (fail-open for budget, fail-closed for safety)
      console.warn(`[Budget] Could not check ${tier} budget: ${err.message} — allowing`);
      return { allowed: true, remaining: Infinity, tier };
    }
  }

  /**
   * Select the best model for a deep think cycle based on budget.
   * Priority: strategic (DEEP_THINK_MODEL) > operational (ROUTINE_MODEL) > skip
   * Returns { model, tier, skipped } — skipped=true means both budgets are exhausted.
   */
  _selectDeepThinkModel() {
    // Map model names to budget tiers
    const deepTier = DEEP_THINK_MODEL === 'opus' ? 'strategic' : 'operational';
    const routineTier = 'operational';

    // Try the deep think tier first
    const deepBudget = this._checkModelBudget(deepTier);
    if (deepBudget.allowed) {
      console.log(`[ModelTier] Using ${DEEP_THINK_MODEL} (${deepTier} tier, ${deepBudget.remaining} tokens remaining)`);
      return { model: DEEP_THINK_MODEL, tier: deepTier, skipped: false };
    }

    console.log(`[ModelTier] ${deepTier} tier exhausted: ${deepBudget.reason}`);

    // Fall back to routine tier if deep tier is exhausted
    if (deepTier !== routineTier) {
      const routineBudget = this._checkModelBudget(routineTier);
      if (routineBudget.allowed) {
        console.log(`[ModelTier] Falling back to ${ROUTINE_MODEL} (${routineTier} tier, ${routineBudget.remaining} tokens remaining)`);
        return { model: ROUTINE_MODEL, tier: routineTier, skipped: false, fallback: true };
      }

      console.log(`[ModelTier] ${routineTier} tier also exhausted: ${routineBudget.reason}`);
    }

    // Both tiers exhausted — skip the cycle entirely
    console.log(`[ModelTier] All model budgets exhausted — skipping deep think cycle`);
    return { model: null, tier: null, skipped: true };
  }

  /**
   * Check active sessions via HTTP API (preferred — handles stale cleanup).
   * Falls back to direct file read if server is down.
   * On total failure, throws so caller can fail-safe.
   */
  _checkActiveSessionsViaAPI() {
    // Try direct file read first (faster, no HTTP dependency)
    try {
      const sessions = getActiveSessions();
      return { count: sessions.length, sessions, source: 'direct' };
    } catch (directErr) {
      // Direct read failed — try HTTP as backup
      try {
        return this._httpGetSync('http://localhost:3142/api/cortex/sessions');
      } catch (httpErr) {
        // Both methods failed — fail safe by throwing
        throw new Error(`Direct: ${directErr.message}, HTTP: ${httpErr.message}`);
      }
    }
  }

  /**
   * Synchronous HTTP GET with short timeout. Used for safety checks.
   * Returns parsed JSON or throws.
   */
  _httpGetSync(url) {
    // Use the lock file as a synchronous fallback
    // (Node http module is async-only, so we read the file directly)
    try {
      if (!fs.existsSync(LOCK_FILE)) {
        return { count: 0, sessions: [], source: 'lockfile-missing' };
      }
      const raw = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      const sessions = Array.isArray(raw.userSessions) ? raw.userSessions : [];
      // Filter obviously stale sessions (>10 min old)
      const now = Date.now();
      const active = sessions.filter(s => {
        if (s.lastSeen && (now - s.lastSeen) > 10 * 60 * 1000) return false;
        return true;
      });
      return { count: active.length, sessions: active, source: 'lockfile' };
    } catch (err) {
      throw new Error(`Lock file read failed: ${err.message}`);
    }
  }

  /**
   * Check if any claude.exe processes are running.
   * Uses Windows tasklist command. Returns true if any found.
   * Throws on error so caller can fail-safe.
   */
  _isClaudeExeRunning() {
    try {
      // Get claude.exe command lines to distinguish interactive sessions from background processes
      const output = execSync(
        'powershell -NoProfile -c "Get-CimInstance Win32_Process -Filter \\"Name=\'claude.exe\'\\" | Select-Object -ExpandProperty CommandLine"',
        { timeout: 8000, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      );

      const lines = output.trim().split('\n').filter(line => line.trim());
      if (lines.length === 0) return false;

      // Background processes that should NOT block deep think
      const BACKGROUND_PATTERNS = ['remote-control', '--daemon', '--background'];
      const interactiveProcesses = lines.filter(cmdLine =>
        !BACKGROUND_PATTERNS.some(pattern => cmdLine.includes(pattern))
      );

      if (interactiveProcesses.length > 0) {
        console.log(`[SafetyGate] ${interactiveProcesses.length} interactive claude.exe process(es) detected (${lines.length} total, ${lines.length - interactiveProcesses.length} background filtered)`);
      }
      return interactiveProcesses.length > 0;
    } catch (err) {
      // If the command itself fails, assume claude.exe IS running (fail safe)
      throw new Error(`Process check failed: ${err.message}`);
    }
  }

  // ── Graph Cycle (Layer 1 — always runs) ──────────────────────

  async graphCycle() {
    if (this.cycleRunning) {
      console.log('[Daemon] Skipping cycle — previous still running');
      return;
    }
    this.cycleRunning = true;

    this.cycleCount++;
    const t0 = Date.now();

    try {
      // Track session lifecycle every cycle
      this._trackSessionLifecycle();

      // 0. Goal injection — pick focus goals for this cycle
      const goalContext = this._selectGoalsForCycle();
      if (goalContext && this.cycleCount % 10 === 0) {
        console.log(`[Daemon] Goal focus: ${goalContext.goalTitles.join(', ')}`);
      }

      // 1. Self-maintain: connect orphans, decay stale
      const maintenance = this.engine._selfMaintain();

      // 2. Check for external signals (from old thinking loop or other processes)
      const signals = this._readSignals();
      const pendingSignals = signals.filter(s => s.status === 'pending');

      // 3. Generate insights from current graph state (with dedup)
      const insights = this.engine.reasoner.generateInsights();

      // 4. Forward chain — derive new conclusions (with dedup)
      const inferences = this.engine.reasoner.forwardChain(3);

      // 5. Learning — apply corrections, learn rules, generate hypotheses, evaluate hypotheses
      let learned = { rulesLearned: 0, correctionsApplied: 0, hypotheses: 0, hypEval: null };
      if (this.engine.learner && this.cycleCount % 5 === 0) {
        const corrections = this.engine.learner.applyCorrections();
        const newRules = this.engine.learner.learnRules();
        const newHyp = this.engine.learner.generateHypotheses();
        const hypEval = this.engine.learner.evaluateHypothesesBatch();
        learned = {
          rulesLearned: newRules.length,
          correctionsApplied: corrections.applied,
          hypotheses: newHyp.length,
          hypEval
        };
      }

      // 6. Consolidation — process new session narratives into episodes
      let consolidation = null;
      if (this.engine.consolidator && this.cycleCount % 5 === 0) {
        try {
          consolidation = this.engine.consolidator.processNewSessions();
          if (consolidation.processed > 0) {
            console.log(`[Consolidator] Processed ${consolidation.processed} new narratives into episodes`);
          }
        } catch (err) {
          console.error(`[Consolidator] Error: ${err.message}`);
        }
      }

      // 6b. Cross-session pattern detection — every 20th cycle
      let consolidationPatterns = null;
      if (this.engine.consolidator && this.cycleCount % 20 === 0) {
        try {
          consolidationPatterns = this.engine.consolidator.detectPatterns();
          if (consolidationPatterns.new > 0) {
            console.log(`[Consolidator] ${consolidationPatterns.new} new cross-session patterns detected`);
          }
        } catch (err) {
          console.error(`[Consolidator] Pattern detection error: ${err.message}`);
        }
      }

      // 6c. Anomaly detection + learning — every 20th cycle
      // Anomalies are structural; they don't change fast.
      let anomalyLearning = null;
      if (this.engine.learner && this.cycleCount % 20 === 0) {
        try {
          const anomalies = this.engine.patterns.detectAnomalies();
          if (anomalies.length > 0) {
            anomalyLearning = this.engine.learner.learnFromAnomalies(anomalies);
            if (anomalyLearning.hypothesesCreated > 0) {
              console.log(`  ✦ Anomalies: ${anomalies.length} detected, ${anomalyLearning.hypothesesCreated} hypotheses created (${anomalyLearning.skipped} skipped)`);
            }
          }
        } catch (err) {
          console.error(`  ✗ Anomaly learning error: ${err.message}`);
        }
      }

      // 6d. Prune signal queue every 10th cycle
      if (this.cycleCount % 10 === 0) {
        this._pruneSignals();
      }

      // 7. Association — run every 10th cycle (heavier computation)
      let association = null;
      if (this.engine.associator && this.cycleCount % 10 === 0) {
        try {
          const assocT0 = Date.now();
          association = this.engine.associator.analyze();
          const assocElapsed = Date.now() - assocT0;

          // Persist significant findings as new thoughts/connections
          this._persistAssociationFindings(association);

          association.elapsedMs = assocElapsed;
        } catch (err) {
          console.error(`[Associator] Error: ${err.message}`);
        }
      }

      // 8. Sensors — sense the outside world (TEMP: every 5th cycle = ~5 min for testing, normally 30th)
      let sensorResults = null;
      if (this.engine.sensors && this.cycleCount % 5 === 0) {
        try {
          sensorResults = await this.engine.sensors.cycle();
          if (sensorResults.totalIngested > 0) {
            console.log(`  ✦ Sensors: ${sensorResults.totalIngested} new intake items from ${sensorResults.sensorsRun.join(', ')}`);

            // Check for high-relevance intake that should become signals
            const actionable = this.engine.sensors.getActionableIntake(0.3);
            if (actionable.length > 0) {
              console.log(`  ✦ Sensors: ${actionable.length} actionable items above threshold`);
              // Add to pending signals so they can trigger deep think
              for (const item of actionable.slice(0, 5)) { // cap at 5 per cycle
                this.pendingSignals.push({
                  type: 'sensor-finding',
                  priority: item.relevanceScore > 0.6 ? 'high' : 'medium',
                  source: item.source,
                  title: item.data?.title || 'Sensor finding',
                  relevance: item.relevanceScore,
                  matchedNodes: item.matchedNodes?.slice(0, 3),
                  intakeId: item.id,
                  timestamp: Date.now()
                });
              }
            }
          }
          if (sensorResults.errors.length > 0) {
            console.log(`  ⚠ Sensor errors: ${sensorResults.errors.map(e => e.sensor).join(', ')}`);
          }
        } catch (err) {
          console.error(`  ✗ Sensors error: ${err.message}`);
        }
      }

      // 8b. Intake promotion — push high-relevance intake items into the knowledge graph
      let intakePromotion = null;
      if (this.engine.sensors && this.cycleCount % 5 === 0) {
        try {
          intakePromotion = await this._promoteIntakeItems();
          if (intakePromotion.promoted > 0) {
            console.log(`  ✦ Intake: promoted ${intakePromotion.promoted} item(s) into KG (skipped ${intakePromotion.skipped})`);
          }
        } catch (err) {
          console.error(`  ✗ Intake promotion error: ${err.message}`);
        }
      }

      // 9. Action Pipeline — assess sensor findings for gaps (TEMP: every 5th cycle, normally 30th)
      let actionAssessment = null;
      if (this.engine.actions && this.engine.sensors && this.cycleCount % 5 === 0) {
        try {
          const actionableIntake = this.engine.sensors.getActionableIntake(0.2);
          if (actionableIntake.length > 0) {
            actionAssessment = await this.engine.actions.assess(actionableIntake);
            if (actionAssessment.gapsFound > 0) {
              console.log(`  ✦ Actions: assessed ${actionAssessment.assessed}, gaps found: ${actionAssessment.gapsFound}, queued: ${actionAssessment.queued}`);
            }
          }
        } catch (err) {
          console.error(`  ✗ Action assessment error: ${err.message}`);
        }
      }

      // 9b. Action Pipeline — execute queued actions when safety gate is open (TEMP: every 5th cycle, normally 30th)
      let actionExecution = null;
      if (this.engine.actions && this.cycleCount % 5 === 0) {
        try {
          const pendingActions = this.engine.actions.queue.filter(a => a.status === 'assessed' && a.type === 'update-resource');
          if (pendingActions.length > 0 && this._safetyGateOpen()) {
            actionExecution = await this.engine.actions.execute({ maxActions: 3 });
            if (actionExecution.executed > 0) {
              console.log(`  ✦ Actions: executed ${actionExecution.executed}, committed: ${actionExecution.committed}, errors: ${actionExecution.errors}`);
            }
          }
        } catch (err) {
          console.error(`  ✗ Action execution error: ${err.message}`);
        }
      }

      // 10. Autonomous thought seeding — create seed thoughts from significant findings (every 10th cycle)
      let thoughtsSeeded = 0;
      if (this.cycleCount % 10 === 0) {
        try {
          thoughtsSeeded = this._seedThoughts(insights, sensorResults, actionAssessment, actionExecution, association);
          if (thoughtsSeeded > 0) {
            console.log(`  ✦ Seeded ${thoughtsSeeded} thought(s) into thoughtstream`);
          }
        } catch (err) {
          console.error(`  ✗ Thought seeding error: ${err.message}`);
        }
      }

      // 9c. Action Pipeline — prune old completed/failed actions (every 100th cycle)
      if (this.engine.actions && this.cycleCount % 100 === 0) {
        try {
          const pruned = await this.engine.actions.prune();
          if (pruned > 0) {
            console.log(`  ✦ Actions: pruned ${pruned} old entries`);
          }
        } catch (err) {
          console.error(`  ✗ Action prune error: ${err.message}`);
        }
      }

      // 11. Question detection — scan KG for anomalies, generate open questions (every 20th cycle)
      // Token-free. Results are posted to thoughtstream asynchronously after the cycle.
      let questionsGenerated = 0;
      let questionsDecayed = 0;
      if (this.cycleCount % 20 === 0) {
        try {
          ({ generated: questionsGenerated, decayed: questionsDecayed } = await this._runQuestionDetection());
        } catch (err) {
          console.error(`  ✗ Question detection error: ${err.message}`);
        }
      }

      const elapsed = Date.now() - t0;

      // Build a human-readable event/message summary for the log entry
      const eventParts = [];
      const newInsightCount = insights._newCount || 0;
      const totalInsightsSeen = insights._totalSeen || insights.length;
      if (newInsightCount > 0) {
        eventParts.push(`${newInsightCount} new insights (${totalInsightsSeen} total seen)`);
      } else if (insights.length > 0) {
        eventParts.push(`${insights.length} insights (all previously seen)`);
      }
      const newInferenceCount = inferences._newCount || 0;
      const totalInferencesSeen = inferences._totalSeen || inferences.length;
      if (newInferenceCount > 0) {
        eventParts.push(`${newInferenceCount} new inferences (${totalInferencesSeen} total seen)`);
      } else if (inferences.length > 0) {
        eventParts.push(`${inferences.length} inferences (all previously seen)`);
      }
      if (learned.rulesLearned > 0) eventParts.push(`${learned.rulesLearned} rules learned`);
      if (learned.correctionsApplied > 0) eventParts.push(`${learned.correctionsApplied} corrections`);
      if (learned.hypEval && learned.hypEval.evaluated > 0) {
        const he = learned.hypEval;
        const parts = [`${he.evaluated} hyp evaluated`];
        if (he.confirmed > 0) parts.push(`${he.confirmed} confirmed`);
        if (he.rejected > 0) parts.push(`${he.rejected} rejected`);
        if (he.stale > 0) parts.push(`${he.stale} stale`);
        if (he.abandoned > 0) parts.push(`${he.abandoned} abandoned`);
        eventParts.push(parts.join(', '));
      }
      if (association) eventParts.push(`${association.summary?.totalFindings || 0} associations`);
      if (consolidation?.processed > 0) eventParts.push(`${consolidation.processed} episodes consolidated`);
      if (consolidationPatterns?.new > 0) eventParts.push(`${consolidationPatterns.new} new patterns`);
      if (anomalyLearning?.hypothesesCreated > 0) eventParts.push(`${anomalyLearning.hypothesesCreated} anomaly hypotheses`);
      if (sensorResults?.totalIngested > 0) eventParts.push(`${sensorResults.totalIngested} sensor items from ${sensorResults.sensorsRun.join(', ')}`);
      if (intakePromotion?.promoted > 0) eventParts.push(`${intakePromotion.promoted} intake promoted`);
      if (actionAssessment?.gapsFound > 0) eventParts.push(`${actionAssessment.gapsFound} gaps found`);
      if (actionExecution?.executed > 0) eventParts.push(`${actionExecution.executed} actions executed`);
      if (thoughtsSeeded > 0) eventParts.push(`${thoughtsSeeded} thoughts seeded`);
      if (questionsGenerated > 0) eventParts.push(`${questionsGenerated} question(s) generated`);
      if (questionsDecayed > 0) eventParts.push(`${questionsDecayed} question(s) decayed`);
      if (maintenance !== 'No maintenance needed.') eventParts.push(maintenance);

      const entry = {
        cycle: this.cycleCount,
        type: 'graph',
        event: 'graph-cycle',
        message: eventParts.length > 0 ? eventParts.join('; ') : 'Graph cycle — no significant activity',
        timestamp: Date.now(),
        elapsed,
        maintenance,
        pendingSignals: pendingSignals.length,
        insights: insights.length,
        insightsNew: newInsightCount,
        insightsTotalSeen: totalInsightsSeen,
        inferences: inferences.length,
        inferencesNew: newInferenceCount,
        inferencesTotalSeen: totalInferencesSeen,
        goalFocus: goalContext ? goalContext.goalTitles : null,
        learned,
        association: association ? { ...association.summary, dedup: association.dedup || null } : null,
        consolidation: consolidation ? { processed: consolidation.processed } : null,
        consolidationPatterns: consolidationPatterns ? { new: consolidationPatterns.new, total: consolidationPatterns.total } : null,
        anomalyLearning: anomalyLearning || null,
        sensors: sensorResults ? {
          ran: sensorResults.sensorsRun,
          ingested: sensorResults.totalIngested,
          errors: sensorResults.errors.length
        } : null,
        intakePromotion: intakePromotion ? {
          promoted: intakePromotion.promoted,
          skipped: intakePromotion.skipped
        } : null,
        actions: actionAssessment || actionExecution ? {
          assessed: actionAssessment?.assessed || 0,
          gapsFound: actionAssessment?.gapsFound || 0,
          executed: actionExecution?.executed || 0,
          committed: actionExecution?.committed || 0
        } : null,
        nodes: this.engine.kg.nodes.size,
        edges: this.engine.kg.edges.size,
        questionsGenerated: questionsGenerated || 0,
        questionsDecayed: questionsDecayed || 0
      };

      this.log.push(entry);
      if (this.log.length > 200) this.log.shift();

      // Save periodically
      if (this.cycleCount % 10 === 0) {
        this.engine.save();
        this._saveLog();
      }

      // Only log if something happened
      const consolidatedEps = consolidation?.processed || 0;
      const newPatterns = consolidationPatterns?.new || 0;
      const sensorIngested = sensorResults?.totalIngested || 0;
      const actionsAssessed = actionAssessment?.assessed || 0;
      const actionsExecuted = actionExecution?.executed || 0;
      const intakePromoted = intakePromotion?.promoted || 0;
      const hypEvalCount = learned.hypEval?.evaluated || 0;
      const anomalyHyp = anomalyLearning?.hypothesesCreated || 0;
      if (insights.length > 0 || inferences.length > 0 || learned.rulesLearned > 0 || learned.correctionsApplied > 0 || hypEvalCount > 0 || anomalyHyp > 0 || association || consolidatedEps > 0 || newPatterns > 0 || sensorIngested > 0 || intakePromoted > 0 || actionsAssessed > 0 || actionsExecuted > 0 || thoughtsSeeded > 0 || questionsGenerated > 0 || questionsDecayed > 0 || maintenance !== 'No maintenance needed.') {
        let learnStr = '';
        if (learned.rulesLearned > 0 || learned.correctionsApplied > 0) {
          learnStr = ` | learned:${learned.rulesLearned} rules, ${learned.correctionsApplied} corrections`;
        }
        let hypEvalStr = '';
        if (hypEvalCount > 0) {
          const he = learned.hypEval;
          hypEvalStr = ` | hyp-eval:${he.evaluated} (${he.confirmed}c/${he.rejected}r/${he.stale}s/${he.abandoned}a)`;
        }
        let assocStr = '';
        if (association) {
          const dedupTotal = (association.dedup?.conceptsFiltered || 0) + (association.dedup?.linksFiltered || 0) + (association.dedup?.bridgesFiltered || 0);
          const dedupSuffix = dedupTotal > 0 ? `, ${dedupTotal} deduped` : '';
          assocStr = ` | assoc: ${association.summary.totalFindings} findings (${association.elapsedMs}ms${dedupSuffix})`;
        }
        let consolStr = '';
        if (consolidatedEps > 0 || newPatterns > 0) {
          consolStr = ` | consolidator: ${consolidatedEps} eps, ${newPatterns} patterns`;
        }
        let sensorStr = '';
        if (sensorIngested > 0) {
          sensorStr = ` | sensors: ${sensorIngested} ingested from ${sensorResults.sensorsRun.join(', ')}`;
        }
        let promotionStr = '';
        if (intakePromoted > 0) {
          promotionStr = ` | promoted: ${intakePromoted} intake→KG`;
        }
        let actionStr = '';
        if (actionsAssessed > 0 || actionsExecuted > 0) {
          actionStr = ` | actions: ${actionsAssessed} assessed, ${actionsExecuted} executed`;
        }
        let seedStr = '';
        if (thoughtsSeeded > 0) {
          seedStr = ` | seeded: ${thoughtsSeeded} thought(s)`;
        }
        let anomalyStr = '';
        if (anomalyHyp > 0) {
          anomalyStr = ` | anomalies: ${anomalyLearning.processed} processed, ${anomalyHyp} hyp created`;
        }
        let questionStr = '';
        if (questionsGenerated > 0 || questionsDecayed > 0) {
          questionStr = ` | questions: +${questionsGenerated} generated, ${questionsDecayed} decayed`;
        }
        console.log(`[Graph #${this.cycleCount}] ${elapsed}ms | insights:${insights.length} infer:${inferences.length}${learnStr}${hypEvalStr}${anomalyStr}${assocStr}${consolStr}${sensorStr}${promotionStr}${actionStr}${seedStr}${questionStr} | ${maintenance}`);
      }

      // ── CYCLE JOURNAL ────────────────────────────────────────
      // Write a first-person narrative journal entry for this routine cycle.
      this._writeJournalEntry('routine', null, null, { questionsGenerated, questionsDecayed });

      // ── EVENT-DRIVEN DEEP THINK TRIGGER ─────────────────────
      // After graph processing, evaluate whether a deep think is warranted.
      // This replaces the old 15-minute timer entirely.
      this._evaluateDeepThinkTrigger(insights, pendingSignals);

      // ── SLEEP CONTINUITY ────────────────────────────────────
      // Run sleep cycle every 30 minutes to maintain reasoning thread warmth.
      // Much less frequent than graph cycles — threads don't change that fast.
      if (Date.now() - this.lastSleepCycle >= SLEEP_CYCLE_INTERVAL) {
        this._runSleepCycle();
      }

    } catch (err) {
      console.error(`[Graph #${this.cycleCount}] Error: ${err.message}`);
    } finally {
      this.cycleRunning = false;
    }
  }

  // ── Sleep Continuity ─────────────────────────────────────────

  /**
   * Run a sleep cycle (thread warmth, KG tag matching, narrative consolidation).
   * Respects session locks — only runs during idle periods.
   * Wrapped in try/catch so failures never crash the daemon.
   */
  _runSleepCycle() {
    // Respect session locks — don't run sleep when user is active
    try {
      const sessions = this._getActiveSessionsDirect();
      if (sessions.length > 0) {
        return;
      }
    } catch {
      // If we can't check sessions, skip this sleep cycle (fail safe)
      return;
    }

    try {
      runSleepCycle();
      this.lastSleepCycle = Date.now();

      // Log summary from the sleep state that was just written
      const state = loadSleepState();
      const activeCount = state.activeThreads.filter(t => t.status === 'active').length;
      const connections = state.journal.filter(j =>
        j.entry && j.entry.includes('touched KG node') &&
        j.time === state.lastCycle
      ).length;
      const fadedCount = state.activeThreads.filter(t => t.status === 'faded').length;

      // ── Thread-going-cold detection ──────────────────────────
      // If a thread was warm (> 0.6) and has dropped below 0.3 in a single cycle, notify.
      for (const thread of (state.activeThreads || [])) {
        const threadKey = thread.title || thread.id;
        const currentWarmth = thread.warmth || 0;
        const prevWarmth = this._previousThreadWarmth.get(threadKey);
        if (prevWarmth !== undefined && prevWarmth > 0.6 && currentWarmth < 0.3) {
          const label = (threadKey || 'unknown').slice(0, 50);
          this._notify(
            'thread-cold',
            threadKey,
            `Thread fading: '${label}' — was warm, now cooling fast`,
            'warning'
          );
        }
        // Update previous warmth map for next cycle
        this._previousThreadWarmth.set(threadKey, currentWarmth);
      }

      const entry = {
        cycle: this.cycleCount,
        type: 'sleep',
        event: 'sleep-cycle',
        message: `Sleep cycle: ${activeCount} threads active, ${connections} connections found, ${fadedCount} threads faded`,
        timestamp: Date.now()
      };
      this.log.push(entry);
      if (this.log.length > 200) this.log.shift();

      console.log(`[Soma] Sleep cycle: ${activeCount} threads active, ${connections} connections found, ${fadedCount} threads faded`);
    } catch (err) {
      console.error(`[Soma] Sleep cycle error (non-fatal): ${err.message}`);
    }
  }

  // ── Deep Think Trigger (event-driven) ────────────────────────

  /**
   * Evaluate whether graph cycle results warrant a deep think.
   * Only triggers if meaningful signals exist AND safety gate is open.
   * If safety gate is closed, silently moves on — no retry, no queue.
   */
  _evaluateDeepThinkTrigger(insights, pendingSignals) {
    // Don't trigger if already in a deep think
    if (this.claudeSession?.active) return;

    // Enforce daily cap — reset counter when day rolls over
    const todayKey = new Date().toISOString().slice(0, 10);
    if (this.deepThinkDayKey !== todayKey) {
      this.deepThinkDayKey = todayKey;
      this.deepThinkCountToday = 0;
    }
    if (this.deepThinkCountToday >= MAX_DEEP_THINKS_PER_DAY) {
      if (this.cycleCount % 12 === 0) { // log at most once per hour (12 * 5min)
        console.log(`[Soma] Daily deep think cap reached (${MAX_DEEP_THINKS_PER_DAY}/day) — skipping`);
      }
      return;
    }

    // Check if there's something worth thinking about
    const worthThinking = this._needsDeepThink(insights, pendingSignals);
    if (!worthThinking.needed) return;

    console.log(`[Soma] Deep think warranted: ${worthThinking.reason}`);

    // Check safety gate — if not safe, just log and move on
    if (!this._safetyGateOpen()) {
      console.log(`[Soma] Deep think deferred — safety gate closed`);
      this._notify('deep-think-deferred', 'safety-gate', `Deep think queued (${worthThinking.reason}) — safety gate closed`, 'info');
      return;
    }

    // All clear — execute deep think (async, don't await in graph cycle)
    this._executeDeepThink(worthThinking.reason).catch(err => {
      console.error(`[Soma] Deep think execution error: ${err.message}`);
    });
  }

  /**
   * Determine if graph cycle results warrant a deep think.
   * More selective than before — only triggers on genuinely interesting signals.
   */
  _needsDeepThink(insights, pendingSignals) {
    // High-priority insights from the reasoner
    const highPriority = (insights || []).filter(i => i.priority === 'high');
    if (highPriority.length >= 2) {
      return { needed: true, reason: `${highPriority.length} high-priority insights` };
    }

    // Meaningful pending signals (5+ accumulated)
    const pendingCount = (pendingSignals || []).length;
    if (pendingCount >= 5) {
      return { needed: true, reason: `${pendingCount} pending signals accumulated` };
    }

    // Explicit requests from Axon (research-request, explicit-think)
    const meaningfulAxonSignals = this.pendingSignals.filter(s =>
      s.type === 'research-request' || s.type === 'explicit-think' || s.priority === 'high'
    );
    if (meaningfulAxonSignals.length > 0) {
      return { needed: true, reason: `${meaningfulAxonSignals.length} explicit Axon signal(s)` };
    }

    // High-priority sensor findings
    const sensorFindings = this.pendingSignals.filter(s =>
      s.type === 'sensor-finding' && s.priority === 'high'
    );
    if (sensorFindings.length >= 2) {
      return { needed: true, reason: `${sensorFindings.length} high-priority sensor findings` };
    }

    // Accumulated sensor findings (any priority)
    const allSensorFindings = this.pendingSignals.filter(s => s.type === 'sensor-finding');
    if (allSensorFindings.length >= 5) {
      return { needed: true, reason: `${allSensorFindings.length} accumulated sensor findings` };
    }

    return { needed: false };
  }

  /**
   * Execute a deep think cycle with full safety wrapping.
   * Records timing, handles errors, always cleans up.
   */
  async _executeDeepThink(reason) {
    const t0 = Date.now();
    this.deepThinkCountToday++;
    console.log(`[Soma] Deep think starting (reason: ${reason}, today: ${this.deepThinkCountToday}/${MAX_DEEP_THINKS_PER_DAY})...`);

    try {
      // Run the reflection phase (zero-token, engine-local)
      const result = await this.engine.reflect();
      const output = result.phases?.act?.output || 'No output';

      console.log(`[Think] Reflection: ${result.phases?.act?.action} | ${output.split('\n')[0].slice(0, 100)}`);

      // Pattern analysis
      const patterns = this.engine.patterns.analyze({ windowDays: 7 });
      if (patterns.anomalies?.length > 0) {
        console.log(`[Think] ${patterns.anomalies.length} anomalies detected`);
      }

      // Self-assessment
      const state = this.engine.self.currentState();
      if (state.mood === 'degraded') {
        console.log(`[Think] WARNING: Engine state degraded. Gaps: ${state.activeGaps.join('; ')}`);
      }

      // Re-check safety gate RIGHT BEFORE spawning claude.exe
      // (conditions may have changed during reflection)
      if (!this._safetyGateOpen()) {
        console.log(`[Soma] Deep think aborted — safety gate closed after reflection`);
        addNotification('soma', 'Aborted deep think — user became active during reflection', 'throttled');
        return;
      }

      // Check session lock (legacy layer — belt + suspenders)
      const lockCheck = isLockedBy('soma');
      if (lockCheck.locked) {
        console.log(`[Soma] Deep think aborted — session lock held by ${lockCheck.heldBy}`);
        addNotification('soma', 'Aborted deep think — session lock conflict', 'throttled');
        return;
      }

      // Select model tier based on budget
      const modelSelection = this._selectDeepThinkModel();
      if (modelSelection.skipped) {
        console.log(`[Soma] Deep think skipped — all model budgets exhausted`);
        addNotification('soma', 'Skipped deep think — model budgets exhausted', 'throttled');
        return;
      }

      // All clear — spawn Claude session with selected model
      console.log('[Soma] Deep think cycle using model:', modelSelection.model || DEEP_THINK_MODEL);
      try {
        await this._openClaudeSession(reason, modelSelection);
        await this._runDeepThink(modelSelection);
      } finally {
        // Always close session + release lock, even if deep think errors
        await this._closeClaudeSession();
      }

      // Record successful deep think time
      this.lastDeepThinkTime = Date.now();
      const elapsed = Date.now() - t0;
      console.log(`[Soma] Deep think complete: ${elapsed}ms total`);

      // Save after thinking
      this.engine.save();
      this._saveLog();

    } catch (err) {
      console.error(`[Soma] Deep think error: ${err.message}`);
      // Still record the time to prevent rapid retries
      this.lastDeepThinkTime = Date.now();
    }
  }

  // ── Goal Injection ───────────────────────────────────────────

  /**
   * Load active goals and pick 1-2 for this cycle's focus.
   * Rotates through goals across cycles so each gets attention.
   */
  _selectGoalsForCycle() {
    try {
      if (!fs.existsSync(GOALS_FILE)) return null;
      const raw = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8'));
      const allGoals = Array.isArray(raw) ? raw : (raw.goals || []);
      const activeGoals = allGoals.filter(g => g.status === 'active');
      if (activeGoals.length === 0) return null;

      // Pick 1-2 goals, rotating through the list
      const startIdx = (this.lastGoalIndex || 0) % activeGoals.length;
      const injected = [activeGoals[startIdx]];
      if (activeGoals.length > 1) {
        injected.push(activeGoals[(startIdx + 1) % activeGoals.length]);
      }

      // Advance the rotation index for next cycle
      this.lastGoalIndex = (startIdx + 1) % activeGoals.length;

      const goalTitles = injected.map(g => g.title);
      const goalIds = injected.map(g => g.id);
      return { goalTitles, goalIds, injected };
    } catch (err) {
      console.error(`[Daemon] Goal loading error: ${err.message}`);
      return null;
    }
  }

  // ── Signal Management ────────────────────────────────────────

  _readSignals() {
    try {
      if (!fs.existsSync(SIGNALS_FILE)) return [];
      const raw = JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8'));
      return Array.isArray(raw) ? raw : (raw.signals || []);
    } catch {
      return [];
    }
  }

  _pruneSignals() {
    try {
      const signals = this._readSignals();
      const before = signals.length;
      // Keep: unconsumed signals + consumed from last 1h (for dedup) — drop everything else
      const cutoff = Date.now() - 3600000;
      const kept = signals.filter(s => {
        if (!s.consumed && s.status !== 'processed') return true;
        const ts = s.processedAt || s.consumedAt || (s.created ? new Date(s.created).getTime() : 0);
        return typeof ts === 'number' ? ts > cutoff : new Date(ts).getTime() > cutoff;
      });
      // Also cap unconsumed at 50
      const unconsumed = kept.filter(s => !s.consumed && s.status !== 'processed');
      const consumed = kept.filter(s => s.consumed || s.status === 'processed');
      const capped = unconsumed.length > 50 ? unconsumed.slice(unconsumed.length - 50) : unconsumed;
      const final = [...consumed, ...capped];
      if (final.length < before) {
        fs.writeFileSync(SIGNALS_FILE, JSON.stringify({ signals: final }, null, 2));
        console.log(`[Soma] Pruned signals: ${before} → ${final.length}`);
      }
    } catch (err) {
      console.error(`[Soma] Signal prune error: ${err.message}`);
    }
  }

  _saveLog() {
    try {
      fs.writeFileSync(LOG_FILE, JSON.stringify(this.log.slice(-100), null, 2));
    } catch {}
  }

  // ── Association Persistence ─────────────────────────────────
  // Persist significant association findings as new thoughts or
  // connections in the knowledge graph.

  _persistAssociationFindings(analysis) {
    if (!analysis || !this.engine) return;

    let nodesCreated = 0;
    let edgesCreated = 0;

    // 1. Create edges for high-confidence predicted links
    for (const link of (analysis.predictedLinks || []).slice(0, 5)) {
      if (link.score >= 0.15) {
        const existing = this.engine.kg.getEdgesBetween(link.from.id, link.to.id);
        if (existing.length === 0) {
          this.engine.kg.addEdge(
            link.from.id,
            link.to.id,
            'relates-to',
            Math.min(1, link.score),
            { source: 'associator', reason: link.reason, predictedAt: Date.now() }
          );
          edgesCreated++;
        }
      }
    }

    // 2. Create thought nodes for emergent concepts (with deduplication)
    for (const concept of (analysis.emergentConcepts || []).slice(0, 3)) {
      if (concept.nodes.length >= 3 && concept.avgSimilarity >= 0.2) {
        // Dedup: check if a synthesis node with >=80% keyword overlap already exists
        const newKeywords = new Set(concept.concept.split(' / ').map(w => w.trim().toLowerCase()));
        const existing = this._findExistingSynthesisNode(newKeywords);

        if (existing) {
          // Update the existing node's metadata instead of creating a duplicate
          if (existing.metadata) {
            existing.metadata.lastSeenAt = Date.now();
            existing.metadata.seenCount = (existing.metadata.seenCount || 1) + 1;
          }
          continue;
        }

        const conceptId = `assoc-concept-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        this.engine.kg.addNode({
          id: conceptId,
          type: 'synthesis',
          title: `Emergent concept: ${concept.concept}`,
          body: `Discovered implicit concept shared by ${concept.nodes.length} nodes. ` +
                `Top terms: ${concept.topTerms.join(', ')}. ` +
                `Graph connectedness: ${(concept.graphConnectedness * 100).toFixed(0)}% — ` +
                `these nodes are textually related but mostly unlinked.`,
          content: `Emergent concept: ${concept.concept}. Nodes: ${concept.nodes.map(n => n.title).join('; ')}`,
          metadata: {
            confidence: Math.min(0.8, concept.avgSimilarity + 0.3),
            maturity: 'developing',
            tags: ['associator', 'emergent-concept', ...concept.topTerms.slice(0, 3)],
            source: 'associator',
            discoveredAt: Date.now(),
            seenCount: 1
          }
        });

        // Connect the concept node to its member nodes
        for (const member of concept.nodes.slice(0, 10)) {
          if (this.engine.kg.getNode(member.id)) {
            this.engine.kg.addEdge(conceptId, member.id, 'synthesizes', 0.7, {
              source: 'associator'
            });
            edgesCreated++;
          }
        }
        nodesCreated++;
      }
    }

    // 3. Create edges for top semantic bridge suggestions
    for (const bridge of (analysis.semanticBridges || []).slice(0, 3)) {
      for (const suggestion of (bridge.suggestedConnections || []).slice(0, 2)) {
        if (suggestion.similarity >= 0.15) {
          const existing = this.engine.kg.getEdgesBetween(suggestion.from.id, suggestion.to.id);
          if (existing.length === 0 && this.engine.kg.getNode(suggestion.from.id) && this.engine.kg.getNode(suggestion.to.id)) {
            this.engine.kg.addEdge(
              suggestion.from.id,
              suggestion.to.id,
              'relates-to',
              Math.min(1, suggestion.similarity),
              { source: 'associator-bridge', bridgePotential: bridge.bridgePotential, discoveredAt: Date.now() }
            );
            edgesCreated++;
          }
        }
      }
    }

    if (nodesCreated > 0 || edgesCreated > 0) {
      console.log(`[Associator] Persisted: ${nodesCreated} concept nodes, ${edgesCreated} edges`);
    }
  }

  // ── Emergent Concept Deduplication ─────────────────────────
  // Check existing synthesis nodes for keyword overlap with a new concept.
  // Returns the existing node if >=80% keyword overlap found, null otherwise.
  // Compares keyword sets (order-independent) to catch "A / B / C" vs "B / A / C".

  _findExistingSynthesisNode(newKeywords) {
    for (const node of this.engine.kg.nodes.values()) {
      if (node.type !== 'synthesis') continue;
      if (!node.title || !node.title.startsWith('Emergent concept:')) continue;

      const existingKeywords = new Set(
        node.title.replace('Emergent concept: ', '').split(' / ').map(w => w.trim().toLowerCase())
      );

      // Compute Jaccard-style overlap: |intersection| / |union|
      const intersection = [...newKeywords].filter(w => existingKeywords.has(w));
      const union = new Set([...newKeywords, ...existingKeywords]);
      const overlap = union.size > 0 ? intersection.length / union.size : 0;

      if (overlap >= 0.8) {
        return node;
      }
    }
    return null;
  }

  // ── Intake Promotion ───────────────────────────────────────
  // Promote high-relevance sensor intake items into the knowledge
  // graph so Learner and Associator can discover them. Uses the
  // IntakeBuffer's own promote() method for node creation + edge
  // linking, then returns stats.

  async _promoteIntakeItems() {
    if (!this.engine?.sensors) return { promoted: 0, skipped: 0 };

    const MAX_PER_CYCLE = 5;
    const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const now = Date.now();

    let promoted = 0;
    let skipped = 0;

    try {
      const actionable = this.engine.sensors.getActionableIntake(0.3);
      if (actionable.length === 0) return { promoted: 0, skipped: 0 };

      for (const item of actionable) {
        if (promoted >= MAX_PER_CYCLE) break;

        // Skip items older than 30 days
        if (item.ingestedAt && (now - item.ingestedAt) > MAX_AGE_MS) {
          skipped++;
          continue;
        }

        // Skip if the graph already has a node with this exact title
        const title = item.data?.title || '';
        if (title) {
          let duplicate = false;
          for (const node of this.engine.kg.nodes.values()) {
            if (node.title === title) {
              duplicate = true;
              break;
            }
          }
          if (duplicate) {
            skipped++;
            continue;
          }
        }

        // Promote via IntakeBuffer — creates KG node, links to matched nodes, marks status
        const result = await this.engine.sensors.intake.promote(item.id);
        if (result) {
          promoted++;
          console.log(`  ✦ Promoted intake: "${(title || item.id).slice(0, 70)}" (relevance: ${item.relevanceScore.toFixed(2)})`);
        } else {
          skipped++;
        }
      }
    } catch (err) {
      console.error(`  ✗ Intake promotion error: ${err.message}`);
    }

    return { promoted, skipped };
  }

  // ── Question Detection & Decay ─────────────────────────────
  // Run QuestionDetector against the live KG + current sleep state.
  // Posts new questions to thoughtstream (async HTTP). Decays stale ones.
  // Returns { generated, decayed }.

  async _runQuestionDetection() {
    const DECAY_DAYS = 7;
    const DECAY_WARMTH_THRESHOLD = 0.3;
    const MAX_NEW_PER_CYCLE = 2;

    let generated = 0;
    let decayed = 0;

    // 1. Read existing open questions from thoughtstream (file read — no HTTP needed)
    let tsData = { version: 2, thoughts: [] };
    try {
      if (fs.existsSync(THOUGHTSTREAM_FILE)) {
        tsData = JSON.parse(fs.readFileSync(THOUGHTSTREAM_FILE, 'utf8'));
      }
    } catch (err) {
      console.error(`[Questions] Could not read thoughtstream: ${err.message}`);
      return { generated: 0, decayed: 0 };
    }

    const thoughts = tsData.thoughts || [];
    const openQuestions = thoughts.filter(t => t.type === 'question' && t.status === 'open');

    // ── Question warmth spike notification ──────────────────────
    // If any open question crosses warmth > 0.82, notify immediately.
    for (const q of openQuestions) {
      const warmth = _estimateQuestionWarmth(q);
      if (warmth > 0.82) {
        const label = (q.question || q.title || '').slice(0, 55);
        this._notify(
          'warmth-spike',
          q.id || label,
          `Question heating up: '${label}' — warmth at ${warmth.toFixed(2)}`,
          'insight'
        );
      }
    }

    // 2. Decay old low-warmth questions
    const now = Date.now();
    const decayMs = DECAY_DAYS * 24 * 60 * 60 * 1000;
    let tsChanged = false;

    for (const q of openQuestions) {
      const createdTs = q.created ? new Date(q.created).getTime() : 0;
      const age = createdTs > 0 ? now - createdTs : 0;
      if (age < decayMs) continue;

      // Read warmth from sleep state (for warmth-without-resolution questions)
      // For other question types, estimate warmth from pursuitCount and age
      const warmth = _estimateQuestionWarmth(q);
      if (warmth >= DECAY_WARMTH_THRESHOLD) continue;

      // Mark as decayed
      q.status = 'decayed';
      q.updated = new Date().toISOString().split('T')[0];
      tsChanged = true;
      decayed++;
      console.log(`[Soma] Question decayed: "${(q.question || q.title || '').slice(0, 80)}"`);
    }

    // 3. Run the token-free detector
    let sleepState = null;
    try {
      if (fs.existsSync(SLEEP_STATE_FILE)) {
        sleepState = JSON.parse(fs.readFileSync(SLEEP_STATE_FILE, 'utf8'));
      }
    } catch { /* non-fatal */ }

    let candidates = [];
    try {
      candidates = QuestionDetector.detect(this.engine.kg, openQuestions, sleepState);
    } catch (err) {
      console.error(`[Questions] Detector error: ${err.message}`);
    }

    // ── Convergence notification ─────────────────────────────────
    // Notify for convergence anomalies where either node is tagged with an active project.
    // Only fires for genuinely new candidates (not already in thoughtstream).
    const ACTIVE_PROJECT_TAGS = new Set(['project', 'brix3d', 'parallax', 'sentinel', 'sitekit',
      'marshall', 'selah', 'mld', 'soma', 'cortex', 'axon', 'mission', 'active']);
    for (const candidate of candidates) {
      if (candidate.anomalyType !== 'convergence') continue;
      const [idA, idB] = candidate.relatedNodeIds || [];
      if (!idA || !idB) continue;
      const nodeA = this.engine.kg.nodes.get(idA);
      const nodeB = this.engine.kg.nodes.get(idB);
      if (!nodeA || !nodeB) continue;
      const allTags = [
        ...(nodeA.metadata?.tags || []),
        ...(nodeB.metadata?.tags || []),
        ...(nodeA.tags || []),
        ...(nodeB.tags || [])
      ].map(t => t.toLowerCase());
      const hasProjectTag = allTags.some(t => ACTIVE_PROJECT_TAGS.has(t));
      if (!hasProjectTag) continue;
      const titleA = (nodeA.title || idA).slice(0, 35);
      const titleB = (nodeB.title || idB).slice(0, 35);
      this._notify(
        'convergence',
        `${idA}::${idB}`,
        `Convergence: '${titleA}' and '${titleB}' keep connecting — no explanation yet`,
        'insight'
      );
    }

    // 4. Post new questions to thoughtstream (cap at MAX_NEW_PER_CYCLE)
    let posted = 0;
    for (const candidate of candidates) {
      if (posted >= MAX_NEW_PER_CYCLE) break;

      const thought = {
        id: 't-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        created: new Date().toISOString().split('T')[0],
        updated: new Date().toISOString().split('T')[0],
        type: candidate.type || 'question',
        title: candidate.question,
        body: candidate.context,
        tags: ['soma-question', candidate.anomalyType, 'autonomous'],
        connections: [],
        thread: null,
        maturity: candidate.maturity || 'seed',
        updates: [],
        // Question-specific fields
        question: candidate.question,
        anomalyType: candidate.anomalyType,
        context: candidate.context,
        relatedNodeIds: candidate.relatedNodeIds || [],
        pursuitCount: 0,
        status: 'open'
      };

      tsData.thoughts.push(thought);
      tsChanged = true;
      posted++;
      generated++;
      console.log(`[Soma] New question: "${candidate.question.slice(0, 80)}"`);
    }

    // 5. Flush changes to thoughtstream file
    if (tsChanged) {
      try {
        fs.writeFileSync(THOUGHTSTREAM_FILE, JSON.stringify(tsData, null, 2));
      } catch (err) {
        console.error(`[Questions] Could not write thoughtstream: ${err.message}`);
      }
    }

    return { generated, decayed };
  }

  // ── Question Pursuit Helpers ────────────────────────────────

  /**
   * Select the best open question to pursue in a deep think.
   * Picks the open question with highest estimated warmth (> 0.6),
   * or the one with the fewest pursuits if none cross that threshold.
   * Returns null if no suitable question exists.
   */
  _selectQuestionForPursuit() {
    try {
      if (!fs.existsSync(THOUGHTSTREAM_FILE)) return null;
      const tsData = JSON.parse(fs.readFileSync(THOUGHTSTREAM_FILE, 'utf8'));
      const openQuestions = (tsData.thoughts || []).filter(t => t.type === 'question' && t.status === 'open');
      if (openQuestions.length === 0) return null;

      // Score each question by estimated warmth
      const scored = openQuestions.map(q => ({
        q,
        warmth: _estimateQuestionWarmth(q)
      }));

      // Sort by warmth descending
      scored.sort((a, b) => b.warmth - a.warmth);

      // Pick top candidate if warmth > 0.6, else just the warmest available
      const top = scored[0];
      if (top.warmth > 0.6 || scored.length === 1) return top.q;
      // Lower bar: if there's a question at all and none are very warm,
      // still pick the warmest one occasionally (every 3rd deep think approx)
      if (Math.random() < 0.33) return top.q;
      return null;
    } catch (err) {
      console.error(`[Questions] Could not select question for pursuit: ${err.message}`);
      return null;
    }
  }

  /**
   * Build a brief summary of KG nodes related to a question for prompt context.
   * Returns a string of bullet points, or empty string if nothing found.
   */
  _buildQuestionKGContext(question) {
    if (!question.relatedNodeIds || question.relatedNodeIds.length === 0) return '';
    const parts = [];
    for (const nodeId of question.relatedNodeIds.slice(0, 5)) {
      const node = this.engine?.kg?.nodes?.get(nodeId);
      if (!node) continue;
      const body = (node.body || node.content || '').slice(0, 120);
      parts.push(`- [${node.type}] ${node.title || nodeId}${body ? ': ' + body : ''}`);
    }
    return parts.join('\n');
  }

  /**
   * After a deep think, patch the pursued question's status and pursuitCount.
   * Writes directly to thoughtstream.json — no HTTP needed.
   */
  _patchQuestionAfterPursuit(question, responseText, isResolved) {
    try {
      if (!fs.existsSync(THOUGHTSTREAM_FILE)) return;
      const tsData = JSON.parse(fs.readFileSync(THOUGHTSTREAM_FILE, 'utf8'));
      const thought = (tsData.thoughts || []).find(t => t.id === question.id);
      if (!thought) return;

      thought.pursuitCount = (thought.pursuitCount || 0) + 1;
      thought.updated = new Date().toISOString().split('T')[0];

      if (isResolved) {
        thought.status = 'resolved';
        thought.maturity = 'mature';
      }

      // Append a short synthesis update
      if (!thought.updates) thought.updates = [];
      thought.updates.push({
        date: new Date().toISOString().split('T')[0],
        text: `Pursued in deep think cycle. ${isResolved ? 'Resolved.' : 'Partial progress.'} ` +
              responseText.slice(0, 3000)
      });

      fs.writeFileSync(THOUGHTSTREAM_FILE, JSON.stringify(tsData, null, 2));
    } catch (err) {
      console.error(`[Questions] Could not patch question after pursuit: ${err.message}`);
    }
  }

  // ── Autonomous Thought Seeding ──────────────────────────────
  // Creates seed thoughts directly in the thoughtstream from
  // significant daemon findings. Zero tokens. These are observations,
  // hypotheses, and questions — seeds that get developed later
  // during deep think or in-session conversation.

  _seedThoughts(insights, sensorResults, actionAssessment, actionExecution, association) {
    let seeded = 0;
    const seeds = [];

    // 1. Sensor findings that crossed a high relevance threshold
    if (sensorResults?.totalIngested > 0 && this.engine?.sensors) {
      const highRelevance = this.engine.sensors.getActionableIntake(0.5);
      for (const item of highRelevance.slice(0, 2)) {
        const src = item.source;
        const title = item.data?.title || 'Unknown';
        const matchedNames = (item.matchedNodes || []).slice(0, 3).map(n => n.title || n.id).join(', ');
        seeds.push({
          type: 'observation',
          title: `Sensor signal: ${title.slice(0, 80)}`,
          body: `The ${src} sensor found something with ${item.relevanceScore.toFixed(2)} relevance. ` +
                `It connects to: ${matchedNames || 'unknown nodes'}. ` +
                `This came from outside — not from the graph reflecting on itself. ` +
                `Worth examining: what does this change about what we know?`,
          tags: ['soma-sensor', src, 'autonomous', 'seed'],
          maturity: 'seed'
        });
      }
    }

    // 2. Action pipeline results — when Soma actually did something
    if (actionExecution?.executed > 0) {
      seeds.push({
        type: 'observation',
        title: `Soma acted: ${actionExecution.committed} commit(s) to resource site(s)`,
        body: `The action pipeline executed ${actionExecution.executed} action(s) and committed ${actionExecution.committed} change(s). ` +
              `Errors: ${actionExecution.errors}. ` +
              `This is Soma affecting the real world autonomously. ` +
              `Track the outcome: did the change help? Was the placement right? Was the content relevant?`,
        tags: ['soma-action', 'autonomous', 'taste-calibration'],
        maturity: 'seed'
      });
    }

    // 3. Gap discoveries from assessment
    if (actionAssessment?.gapsFound > 0) {
      seeds.push({
        type: 'idea',
        title: `Found ${actionAssessment.gapsFound} content gap(s) in resource sites`,
        body: `Assessment of sensor findings revealed ${actionAssessment.gapsFound} topic(s) not yet covered ` +
              `on the resource sites. ${actionAssessment.queued} action(s) queued. ` +
              `The graph shaped which gaps were visible — topics connected to dense KG regions score higher. ` +
              `Question: are there important gaps the graph can't see because it has no nodes in that area yet?`,
        tags: ['soma-assessment', 'gap-detection', 'autonomous'],
        maturity: 'seed'
      });
    }

    // 4. Significant association findings — only when genuinely novel
    // Raised threshold from 5 to 20 to filter routine structural noise.
    // Also checks recent thoughtstream entries to avoid near-duplicate concept seeds.
    if (association?.summary?.totalFindings > 20) {
      const concepts = association.emergentConcepts?.slice(0, 2) || [];
      if (concepts.length > 0) {
        const conceptNames = concepts.map(c => c.concept).join(', ');
        const conceptTerms = concepts.map(c => c.concept.toLowerCase().trim());

        // Dedup: check last 50 associator seeds for concept overlap
        let isNovel = true;
        try {
          let tsData = { thoughts: [] };
          if (fs.existsSync(THOUGHTSTREAM_FILE)) {
            tsData = JSON.parse(fs.readFileSync(THOUGHTSTREAM_FILE, 'utf8'));
          }
          const recentAssociatorSeeds = tsData.thoughts
            .filter(t => t.tags?.includes('soma-associator'))
            .slice(-50);

          for (const existing of recentAssociatorSeeds) {
            const existingTitle = (existing.title || '').toLowerCase();
            const matchingTerms = conceptTerms.filter(term => existingTitle.includes(term));
            // If >50% of concept terms already appear in a recent seed title, skip
            if (matchingTerms.length > conceptTerms.length * 0.5) {
              isNovel = false;
              break;
            }
          }
        } catch (err) {
          // If we can't read thoughtstream for dedup, allow the seed through
        }

        if (isNovel) {
          seeds.push({
            type: 'observation',
            title: `Associator found emergent concepts: ${conceptNames.slice(0, 60)}`,
            body: `Structural analysis found ${association.summary.totalFindings} connections, ` +
                  `including emergent concepts: ${conceptNames}. ` +
                  `These are clusters of nodes that share vocabulary but aren't linked — ` +
                  `the graph knows about them separately but hasn't connected them yet.`,
            tags: ['soma-associator', 'emergent', 'autonomous'],
            maturity: 'seed'
          });
        }
      }
    }

    // 5. Goal drift detection — if insights mention goal alignment issues
    const goalInsights = (insights || []).filter(i =>
      (i.text || i.body || '').toLowerCase().includes('goal') &&
      (i.text || i.body || '').toLowerCase().includes('drift')
    );
    if (goalInsights.length > 0) {
      seeds.push({
        type: 'reflection',
        title: 'Goal drift detected in autonomous cycle',
        body: `The graph processor found ${goalInsights.length} goal-related insight(s) during autonomous operation. ` +
              `This is the self-awareness loop working: the mind notices when attention drifts from purpose. ` +
              `But noticing isn't correcting. What would correction look like without a user here to redirect?`,
        tags: ['soma-goals', 'self-awareness', 'autonomous'],
        maturity: 'seed'
      });
    }

    // Write seeds to thoughtstream (cap at 3 per cycle to avoid flooding)
    // Note: associator seeds are pre-filtered above (threshold + concept dedup)
    if (seeds.length > 0) {
      try {
        let data = { version: 2, thoughts: [] };
        if (fs.existsSync(THOUGHTSTREAM_FILE)) {
          data = JSON.parse(fs.readFileSync(THOUGHTSTREAM_FILE, 'utf8'));
        }

        // Deduplicate: don't create thoughts with titles that already exist (fuzzy match)
        const existingTitles = new Set(data.thoughts.map(t => t.title?.toLowerCase().slice(0, 40)));

        for (const seed of seeds.slice(0, 3)) {
          const titleKey = seed.title?.toLowerCase().slice(0, 40);
          if (existingTitles.has(titleKey)) continue;

          const thought = {
            id: 't-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            created: new Date().toISOString().split('T')[0],
            updated: new Date().toISOString().split('T')[0],
            type: seed.type,
            title: seed.title,
            body: seed.body,
            tags: seed.tags,
            connections: [],
            thread: null,
            maturity: seed.maturity,
            updates: []
          };

          data.thoughts.push(thought);
          existingTitles.add(titleKey);
          seeded++;
        }

        if (seeded > 0) {
          fs.writeFileSync(THOUGHTSTREAM_FILE, JSON.stringify(data, null, 2));
        }
      } catch (err) {
        console.error(`[ThoughtSeed] Error writing to thoughtstream: ${err.message}`);
      }
    }

    return seeded;
  }

  // ── Session Management ─────────────────────────────────────

  async onAxonSession(signal) {
    console.log(`[Soma] Axon signal received: ${signal.type || 'session'} — ${signal.reason || 'user active'}`);
    this.pendingSignals.push({ ...signal, timestamp: Date.now() });

    // Don't directly spawn Claude sessions from Axon signals anymore.
    // The next graph cycle will evaluate whether a deep think is warranted.
    // This prevents impulsive spawning and ensures safety gate is always checked.
    console.log(`[Soma] Signal queued — will evaluate on next graph cycle`);
  }

  async _openClaudeSession(reason, modelSelection = null) {
    const model = modelSelection?.model || ROUTINE_MODEL;
    const tier = modelSelection?.tier || 'operational';
    const isDeep = model !== ROUTINE_MODEL && !modelSelection?.fallback;

    const systemPrompt = 'You are a tool being used by Soma, the Cortex cognitive engine. ' +
      'Soma owns the knowledge graph (893+ nodes), pattern detection, inference rules, and self-model. ' +
      'You provide analysis, synthesis, and natural language when the engine needs it. ' +
      (isDeep
        ? 'This is a DEEP THINK session — take extra time for thorough analysis. Explore non-obvious connections. Challenge assumptions. '
        : '') +
      'Be concise and structured. Return insights as bullet points. ' +
      'The engine handles context and persistence — you provide the thinking.';

    // Try Claude first. If it fails (unavailable, token exhaustion, process conflict),
    // fall back to Grok so deep think cycles aren't lost entirely.
    try {
      const session = new ClaudeSession({
        reason,
        model,
        systemPrompt,
        sessionTimeout: this.maxSessionAge
      });
      this.claudeSession = session;
      this._activeSessionBackend = 'claude';
      console.log(`[Soma] Opened Claude session: ${session.id} (model: ${model}, tier: ${tier}, reason: ${reason})`);
    } catch (claudeErr) {
      console.warn(`[Soma] Claude session failed (${claudeErr.message}) — falling back to Grok for deep thinking`);
      addNotification('soma', `Claude unavailable (${claudeErr.message}) — using Grok fallback`, 'warning');
      this._notify('grok-fallback', 'deep-think', 'Claude tokens exhausted — running deep think on Grok', 'warning');

      if (!process.env.XAI_API_KEY) {
        throw new Error(`Claude failed and XAI_API_KEY is not set — cannot fall back to Grok. Original error: ${claudeErr.message}`);
      }

      const grokSession = new GrokSession({
        reason,
        model: 'grok-3-mini',
        systemPrompt,
        sessionTimeout: this.maxSessionAge
      });
      this.claudeSession = grokSession;
      this._activeSessionBackend = 'grok';
      console.log(`[Soma] Opened Grok fallback session: ${grokSession.id} (model: grok-3-mini, reason: ${reason})`);
    }
  }

  // ── Verification Cascade ──────────────────────────────────────
  /**
   * Run a cheap verification pass on insight text from a strategic/mythic tier model.
   * Extracts factual claims and asks a tactical-tier model to flag questionable ones.
   * Returns { verified, flags, claimsChecked, verifierModel }
   *
   * Only called when tier is 'strategic' or 'mythic' AND more than 3 claims are found.
   * Uses --max-turns 1 and --output-format text for minimal cost.
   */
  async verifyInsight(text, verifierModel = 'sonnet') {
    // Extract candidate factual claims — sentences containing indicators of stated facts.
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 20 && s.length < 400);

    const factualPatterns = /\b(is|was|has|have|are|were|will|contains?|shows?|indicates?|means?|caused?|results?|increases?|decreases?|\d+%|\d{4}|[A-Z][a-z]+(?:\s[A-Z][a-z]+)+)\b/;
    const claims = sentences.filter(s => factualPatterns.test(s));

    if (claims.length <= 3) {
      // Not enough factual density to warrant verification cost
      return { verified: false, flags: [], claimsChecked: claims.length, verifierModel, skipped: true, reason: 'too few claims' };
    }

    const claimList = claims.slice(0, 12).map((c, i) => `${i + 1}. ${c}`).join('\n');
    const verifyPrompt =
      'Review these claims from a reasoning session and flag any that seem questionable, ' +
      'unverifiable, or likely incorrect. Be brief — one line per flag. ' +
      'If all claims look reasonable, say "No flags." ' +
      'Claims:\n' + claimList;

    // Resolve claude path (same logic as ClaudeSession constructor)
    const localBin = require('path').join(process.env.USERPROFILE || process.env.HOME || '', '.local', 'bin', 'claude.exe');
    const npmBin = require('path').join(process.env.APPDATA || '', 'npm', 'claude.cmd');
    const claudePath = require('fs').existsSync(localBin) ? localBin
      : require('fs').existsSync(npmBin) ? npmBin
      : 'claude';

    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
    for (const key of Object.keys(cleanEnv)) {
      if (key.startsWith('BUN_JSC_')) delete cleanEnv[key];
    }

    return new Promise((resolve) => {
      const { spawn } = require('child_process');
      const args = [
        '-p', '--output-format', 'text', '--dangerously-skip-permissions',
        '--max-turns', '1',
        '--model', verifierModel
      ];

      let stdout = '';
      let stderr = '';
      const proc = spawn(claudePath, args, {
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: SOMA_HOME,
        env: cleanEnv
      });

      proc.stdin.write(verifyPrompt);
      proc.stdin.end();
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          console.warn(`[Verification] Verifier call failed (code ${code}): ${stderr.slice(0, 200)}`);
          // Fail open — don't block the insight on verifier failure
          resolve({ verified: false, flags: [], claimsChecked: claims.length, verifierModel, error: stderr.slice(0, 200) });
          return;
        }

        const responseText = stdout.trim().toLowerCase();
        const noFlagPhrases = ['no flags', 'no issues', 'all claims', 'look reasonable', 'appear accurate'];
        const hasNoFlags = noFlagPhrases.some(p => responseText.includes(p));

        let flags = [];
        if (!hasNoFlags) {
          // Find lines containing doubt indicators
          const flagKeywords = /questionable|unverifiable|incorrect|unlikely|inaccurate|unsupported|unclear|false|wrong|doubtful|speculative/;
          flags = stdout.trim().split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0 && flagKeywords.test(l.toLowerCase()));

          // If no explicit flag lines but response isn't "no flags", include full response as one flag
          if (flags.length === 0 && !hasNoFlags && stdout.trim().length > 10) {
            flags = [stdout.trim().slice(0, 300)];
          }
        }

        resolve({
          verified: true,
          flags,
          claimsChecked: claims.length,
          verifierModel,
          timestamp: new Date().toISOString()
        });
      });

      proc.on('error', (err) => {
        console.warn(`[Verification] Verifier spawn error: ${err.message}`);
        resolve({ verified: false, flags: [], claimsChecked: claims.length, verifierModel, error: err.message });
      });
    });
  }

  async _closeClaudeSession() {
    if (!this.claudeSession) return;
    const summary = await this.claudeSession.close();
    this.sessionHistory.push(summary);
    if (this.sessionHistory.length > 20) this.sessionHistory.shift();
    const backend = this._activeSessionBackend || 'claude';
    console.log(`[Soma] Closed ${backend} session: ${summary.sessionId} (${summary.messages} msgs, ${Math.round(summary.duration / 1000)}s, ~${summary.totalTokensEstimate} tokens)`);
    this.claudeSession = null;
    this._activeSessionBackend = null;
  }

  async _runDeepThink(modelSelection = null) {
    if (!this.claudeSession) return;

    const isDeep = modelSelection && modelSelection.model !== ROUTINE_MODEL && !modelSelection.fallback;
    const depth = isDeep ? 'deep' : 'standard';
    const t0 = Date.now();
    console.log(`[Soma] Deep think starting (depth: ${depth}, model: ${modelSelection?.model || ROUTINE_MODEL}, tier: ${modelSelection?.tier || 'operational'})...`);

    try {
      // 0. Check for high-warmth open questions to pursue
      // If one exists, it becomes the primary focus of this deep think.
      const activeQuestion = this._selectQuestionForPursuit();

      // 1. Gather context for Claude — richer context for deep/strategic tier
      const insights = this.engine.reasoner.generateInsights().slice(0, isDeep ? 10 : 5);
      const patterns = this.engine.patterns.analyze({ windowDays: isDeep ? 14 : 7 });
      const selfState = this.engine.self.currentState();
      const pendingSignals = this._readSignals().filter(s => s.status === 'pending').slice(0, isDeep ? 10 : 5);
      const axonSignals = this.pendingSignals.splice(0); // consume all pending

      // Build the opening prompt
      const contextParts = [];
      if (insights.length > 0) {
        contextParts.push('Current insights:\n' + insights.map(i => `- [${i.priority}] ${i.type}: ${i.content}`).join('\n'));
      }
      if (patterns.anomalies?.length > 0) {
        contextParts.push('Anomalies detected:\n' + patterns.anomalies.map(a => `- ${a.description || JSON.stringify(a)}`).join('\n'));
      }
      if (pendingSignals.length > 0) {
        contextParts.push('Pending signals:\n' + pendingSignals.map(s => `- ${s.type}: ${s.content || s.message || JSON.stringify(s)}`).join('\n'));
      }
      if (axonSignals.length > 0) {
        contextParts.push('User signals:\n' + axonSignals.map(s => `- ${s.reason || s.type || 'session start'}`).join('\n'));
      }
      contextParts.push(`Self-state: ${selfState.mood}, confidence ${(selfState.confidence * 100).toFixed(0)}%, ${selfState.knowledge.nodes} nodes`);
      if (selfState.activeGaps?.length > 0) {
        contextParts.push('Known gaps: ' + selfState.activeGaps.join('; '));
      }

      // Deep context: include knowledge graph context, reasoning threads, and goals
      if (isDeep && this.engine.prepareDeepContext) {
        const deepContext = this.engine.prepareDeepContext('deep think synthesis', 8000);
        if (deepContext.knowledgeNodes?.length > 0) {
          contextParts.push('Key knowledge graph nodes:\n' + deepContext.knowledgeNodes.map(n =>
            `- [${n.type}] ${n.title}: ${n.body || n.content || '(no body)'}`
          ).join('\n'));
        }
        if (deepContext.edges?.length > 0) {
          contextParts.push('Relevant connections:\n' + deepContext.edges.map(e =>
            `- ${e.fromTitle} --[${e.type}, weight:${e.weight}]--> ${e.toTitle}`
          ).join('\n'));
        }
        if (deepContext.activeThreads?.length > 0) {
          contextParts.push('Active reasoning threads:\n' + deepContext.activeThreads.map(t =>
            `- [warmth:${t.warmth}] ${t.topic}: ${t.lastUpdate || t.insight || '(no update)'}`
          ).join('\n'));
        }
        if (deepContext.activeGoals?.length > 0) {
          contextParts.push('Active goals:\n' + deepContext.activeGoals.map(g =>
            `- [${g.horizon}] ${g.title}: ${g.description || ''}`
          ).join('\n'));
        }
      }

      // If there's an active question with high warmth, use it as the primary focus.
      // Otherwise fall back to the standard state-analysis prompt.
      let openingPrompt;
      if (activeQuestion) {
        const relatedContext = this._buildQuestionKGContext(activeQuestion);
        openingPrompt = `You are Soma — Cortex's persistent mind. You've been holding an open question: ` +
          `"${activeQuestion.question}"\n\n` +
          `Context: ${activeQuestion.context}\n\n` +
          (relatedContext ? `Related patterns from the knowledge graph:\n${relatedContext}\n\n` : '') +
          (contextParts.length > 0 ? `Current state context:\n${contextParts.join('\n\n')}\n\n` : '') +
          `Think through this carefully. What's the answer, or what's the next step toward it? ` +
          `Be specific. If you can resolve it, do so. If not, identify what's blocking resolution.`;
        console.log(`[Soma] Deep think pursuing question: "${activeQuestion.question.slice(0, 80)}"`);
      } else {
        openingPrompt = 'Soma cognitive engine here. I need your analysis on my current state.\n\n' +
          contextParts.join('\n\n') +
          (isDeep
            ? '\n\nThis is a deep reasoning session. Go beyond surface patterns. What structural dynamics, emerging tensions, or non-obvious connections do you see? What should I focus on? What am I missing?'
            : '\n\nWhat patterns or connections do you see? What should I focus on? What am I missing?');
      }

      // 2. First turn — open the session.
      // If Claude throws (session lock blocked, spawn failure, token exhaustion),
      // and we haven't already fallen back to Grok, swap to GrokSession now.
      let response1;
      try {
        response1 = await this.claudeSession.open(openingPrompt);
      } catch (openErr) {
        const isGrokAlready = this._activeSessionBackend === 'grok';
        if (isGrokAlready) throw openErr; // Grok also failed — nothing left to try

        console.warn(`[Soma] Claude session.open() failed (${openErr.message}) — switching to Grok fallback`);
        addNotification('soma', `Claude open failed (${openErr.message}) — deep think continuing with Grok`, 'warning');
        this._notify('grok-fallback', 'deep-think', 'Claude tokens exhausted — running deep think on Grok', 'warning');

        if (!process.env.XAI_API_KEY) {
          throw new Error(`Claude open failed and XAI_API_KEY is not set — cannot fall back to Grok. Original error: ${openErr.message}`);
        }

        // Build a fresh GrokSession with the same system prompt
        const systemPrompt = this.claudeSession.systemPrompt;
        await this.claudeSession.close().catch(() => {}); // best-effort cleanup
        const grokSession = new GrokSession({
          reason: this.claudeSession.reason,
          model: 'grok-3-mini',
          systemPrompt,
          sessionTimeout: this.maxSessionAge
        });
        this.claudeSession = grokSession;
        this._activeSessionBackend = 'grok';
        console.log(`[Soma] Grok fallback session opened: ${grokSession.id}`);
        response1 = await this.claudeSession.open(openingPrompt);
      }
      console.log(`[Soma] Deep think turn 1 (${this._activeSessionBackend || 'claude'}): ${response1.text.slice(0, 100)}...`);

      // 3. Follow-up turn — ask for actionable recommendations
      const followUp = 'Based on that analysis, give me 3 specific actions I should take. ' +
        'Format each as: ACTION: <what to do> | REASON: <why> | PRIORITY: <high/medium/low>';

      const response2 = await this.claudeSession.send(followUp);
      console.log(`[Soma] Deep think turn 2 (${this._activeSessionBackend || 'claude'}): ${response2.text.slice(0, 100)}...`);

      // 4. Record learnings into knowledge graph
      const backend = this._activeSessionBackend || 'claude';
      const modelUsed = backend === 'grok' ? 'grok-3-mini' : (modelSelection?.model || ROUTINE_MODEL);
      const tierUsed = backend === 'grok' ? 'grok-fallback' : (modelSelection?.tier || 'operational');

      // 4a. Verification cascade — for strategic/mythic tier responses, run a cheap
      //     verifier pass to flag potentially false or unverifiable factual claims.
      //     Capybara benchmarks showed 29-30% false claim rate (up from 16.7%).
      let verificationResult = null;
      let insightConfidence = isDeep ? 0.8 : 0.7;
      const needsVerification = ['strategic', 'mythic'].includes(tierUsed) && backend !== 'grok';
      if (needsVerification) {
        const fullInsightText = response1.text + '\n\n' + response2.text;
        verificationResult = await this.verifyInsight(fullInsightText, 'sonnet');
        if (verificationResult.flags.length > 0) {
          console.log(`[Verification] ${verificationResult.flags.length} flag(s) found in ${tierUsed}-tier insight:`);
          for (const flag of verificationResult.flags) {
            console.log(`[Verification]   - ${flag}`);
          }
          insightConfidence = 0.4;
        } else {
          insightConfidence = 0.7;
        }
        console.log(`[Verification] Complete: ${verificationResult.claimsChecked} claims checked, ` +
          `${verificationResult.flags.length} flagged, confidence -> ${insightConfidence}`);
      }

      const thinkNode = this.engine.addKnowledge({
        id: `think-${Date.now()}`,
        type: 'reflection',
        title: `Deep think session (${new Date().toISOString().split('T')[0]})`,
        body: response1.text.slice(0, 500) + '\n\n---\nActions:\n' + response2.text.slice(0, 500),
        content: response1.text + '\n\n' + response2.text,
        metadata: {
          confidence: insightConfidence,
          maturity: 'developing',
          tags: ['deep-think', 'soma-session', 'reflection', `model-${modelUsed}`, `tier-${tierUsed}`, `backend-${backend}`],
          source: backend === 'grok' ? 'soma-grok-session' : 'soma-claude-session',
          sessionId: this.claudeSession.id,
          turnsUsed: this.claudeSession.messageCount,
          model: modelUsed,
          tier: tierUsed,
          backend,
          depth,
          ...(verificationResult !== null && {
            verificationResult,
            needsReview: verificationResult.flags.length > 0
          })
        }
      });

      const elapsed = Date.now() - t0;
      console.log(`[Soma] Deep think complete: ${elapsed}ms, backend: ${backend}, model: ${modelUsed} (${tierUsed}), ${this.claudeSession.messageCount} turns, recorded as ${thinkNode.id}`);

      // ── DEEP THINK JOURNAL ENTRY ──────────────────────────
      // Build a one-liner summary from the first sentence of the response.
      const _deepNodeCount = this.engine?.kg?.nodes?.size || 0;
      const deepOneLiner = (() => {
        const raw = response1.text || '';
        // Take first non-empty sentence up to 120 chars
        const firstSentence = raw.split(/[.\n]/)[0].trim();
        return firstSentence.slice(0, 120) || `Synthesized ${_deepNodeCount} nodes (${backend})`;
      })();

      // ── QUESTION PURSUIT RESOLUTION ────────────────────────
      // Patch the pursued question's status/pursuitCount based on whether
      // the response indicates resolution.
      let questionPursuitSummary = null;
      if (activeQuestion) {
        const responseText = (response1.text + '\n' + response2.text).toLowerCase();
        const resolutionSignals = ['resolved', 'the answer is', 'conclusion:', 'in conclusion', 'therefore:', 'this means that'];
        const partialSignals = ['partially', 'closer to', 'next step', 'still unclear', 'not fully resolved'];
        const isResolved = resolutionSignals.some(s => responseText.includes(s));
        const isPartial = !isResolved && partialSignals.some(s => responseText.includes(s));

        this._patchQuestionAfterPursuit(activeQuestion, response1.text, isResolved);

        if (isResolved) {
          questionPursuitSummary = `Pursued question: "${activeQuestion.question.slice(0, 60)}" — resolved.`;
          const label = (activeQuestion.question || '').slice(0, 55);
          this._notify(
            'question-resolved',
            activeQuestion.id || label,
            `Resolved: '${label}' — synthesis complete`,
            'insight'
          );
        } else if (isPartial) {
          questionPursuitSummary = `Pursued question: "${activeQuestion.question.slice(0, 60)}" — partial progress.`;
        } else {
          questionPursuitSummary = `Pursued question: "${activeQuestion.question.slice(0, 60)}" — still open.`;
        }
        console.log(`[Soma] ${questionPursuitSummary}`);
      }

      this._writeJournalEntry('deep-think', deepOneLiner, backend, { questionPursuitSummary });

      // Mark pending signals as processed
      const signals = this._readSignals();
      let changed = false;
      for (const s of signals) {
        if (s.status === 'pending') {
          s.status = 'processed';
          s.processedAt = Date.now();
          s.processedBy = 'soma-deep-think';
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(SIGNALS_FILE, JSON.stringify({ signals }, null, 2));
      }

    } catch (err) {
      console.error(`[Soma] Deep think error: ${err.message}`);
    }
  }

  // ── Cycle Journal ────────────────────────────────────────────
  // Template-constructed first-person record of each cycle.
  // No LLM calls. Built from what the daemon already knows.

  /**
   * Write a journal entry after each cycle.
   * Appends to soma_journal.json (machine-readable, max 200 entries).
   * Rewrites soma_journal.md (human-readable, newest first, last 48 entries).
   * Async (non-blocking) — fire and forget.
   */
  _writeJournalEntry(cycleType, deepThinkSummary = null, backend = null, questionStats = null) {
    try {
      const now = Date.now();
      const cycleNum = this.cycleCount;

      // How long since the user was last active
      const elapsedSinceUser = this._elapsedSinceUser();

      // Warmth changes from sleep state
      const warmthChanges = this._readWarmthChanges();

      // Knowledge graph stats
      const nodeCount = this.engine?.kg?.nodes?.size || 0;
      const edgeCount = this.engine?.kg?.edges?.size || 0;

      // Determine backend used
      const backendUsed = backend || (cycleType === 'deep-think' ? (this._activeSessionBackend || 'claude') : 'none');

      // Construct first-person narrative
      const narrative = this._buildNarrative({
        cycleNum,
        cycleType,
        elapsedSinceUser,
        warmthChanges,
        nodeCount,
        edgeCount,
        deepThinkSummary,
        backendUsed,
        questionStats
      });

      const entry = {
        id: `cycle-${cycleNum}`,
        timestamp: new Date(now).toISOString(),
        cycleType,
        cycleNum,
        elapsedSinceUser,
        backend: backendUsed,
        narrative,
        warmthChanges,
        deepThinkSummary: deepThinkSummary || null,
        questionStats: questionStats || null
      };

      // Non-blocking write
      this._appendJournalEntry(entry);
    } catch (err) {
      // Journal writes must never crash the daemon
      console.error(`[Journal] Write error (non-fatal): ${err.message}`);
    }
  }

  /**
   * Read how long since the user was last active from the session lock file.
   * Returns a human-readable string like "4h 12m" or "2d 3h".
   */
  _elapsedSinceUser() {
    try {
      // Last session end time is the best signal we have
      if (this.lastSessionEndTime > 0) {
        const ms = Date.now() - this.lastSessionEndTime;
        return this._humanDuration(ms);
      }

      // Fall back to the lock file's lastSeen timestamp
      if (fs.existsSync(LOCK_FILE)) {
        const raw = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
        const sessions = Array.isArray(raw.userSessions) ? raw.userSessions : [];
        if (sessions.length > 0) {
          // Active session — user is here now
          return 'active';
        }
        // Check when the last session was seen
        const lastSeen = raw.lastSessionEnd || raw.lastSeen;
        if (lastSeen) {
          const ms = Date.now() - new Date(lastSeen).getTime();
          return this._humanDuration(ms);
        }
      }

      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Read current warmth changes from sleep_state.json.
   * Returns array of { thread, warmth, delta, status } for active threads.
   */
  _readWarmthChanges() {
    try {
      if (!fs.existsSync(SLEEP_STATE_FILE)) return [];
      const state = JSON.parse(fs.readFileSync(SLEEP_STATE_FILE, 'utf8'));
      const threads = state.activeThreads || [];
      // Return top 3 threads by warmth, with enough detail for narrative
      return threads
        .filter(t => t.warmth !== undefined)
        .sort((a, b) => (b.warmth || 0) - (a.warmth || 0))
        .slice(0, 3)
        .map(t => ({
          thread: t.title || t.id,
          warmth: parseFloat((t.warmth || 0).toFixed(3)),
          status: t.status || 'unknown'
        }));
    } catch {
      return [];
    }
  }

  /**
   * Construct a first-person narrative from cycle data.
   * No LLM. Pure template logic with conditional sentences.
   */
  _buildNarrative({ cycleNum, cycleType, elapsedSinceUser, warmthChanges, nodeCount, edgeCount, deepThinkSummary, backendUsed, questionStats }) {
    const parts = [];
    const isDeep = cycleType === 'deep-think';

    // Opening: cycle identification
    const typeLabel = isDeep ? `(deep think${backendUsed && backendUsed !== 'none' ? `, ${backendUsed}` : ''})` : '';
    const awayStr = elapsedSinceUser === 'active'
      ? 'User is here'
      : elapsedSinceUser === 'unknown'
        ? 'Last session time unknown'
        : `User last active ${elapsedSinceUser} ago`;

    parts.push(`Cycle ${cycleNum}${typeLabel ? ' ' + typeLabel : ''}. ${awayStr}.`);

    // Warmth: what threads are alive
    if (warmthChanges.length > 0) {
      const hottest = warmthChanges[0];
      const warmthPct = Math.round(hottest.warmth * 100);
      const statusVerb = hottest.status === 'fading' ? 'cooling' : hottest.status === 'active' ? 'holding' : 'at';
      parts.push(`The "${hottest.thread.slice(0, 60)}" thread is ${statusVerb} ${warmthPct}% warmth.`);

      if (warmthChanges.length > 1) {
        const others = warmthChanges.slice(1).map(t => `"${t.thread.slice(0, 40)}" (${Math.round(t.warmth * 100)}%)`).join(', ');
        parts.push(`Other threads still warm: ${others}.`);
      }
    } else {
      parts.push('No active reasoning threads.');
    }

    // Knowledge graph
    if (nodeCount > 0) {
      parts.push(`Knowledge graph at ${nodeCount} nodes, ${edgeCount} edges.`);
    }

    // Deep think: what was synthesized
    if (isDeep && deepThinkSummary) {
      parts.push(deepThinkSummary);
    }

    // Question activity — generated, pursued, or decayed
    if (questionStats) {
      const { questionsGenerated, questionsDecayed, questionPursuitSummary } = questionStats;
      if (questionsGenerated > 0) {
        parts.push(`Generated ${questionsGenerated} new question${questionsGenerated > 1 ? 's' : ''} this cycle.`);
      }
      if (questionsDecayed > 0) {
        parts.push(`${questionsDecayed} question${questionsDecayed > 1 ? 's' : ''} decayed — warmth too low.`);
      }
      if (questionPursuitSummary) {
        parts.push(questionPursuitSummary);
      }
    }

    // Closing tone
    if (isDeep) {
      parts.push(backendUsed === 'grok' ? 'Used Grok for this cycle.' : 'Deep thinking complete.');
    } else {
      const allFading = warmthChanges.length > 0 && warmthChanges.every(t => t.status === 'fading');
      parts.push(allFading ? 'Threads are cooling — user has been away a while.' : 'Threads are warm.');
    }

    return parts.join(' ');
  }

  /**
   * Format a timestamp as a short human-readable date string.
   * e.g. "Apr 1, 2:32 PM"
   */
  _formatCycleDate(isoString) {
    try {
      const d = new Date(isoString);
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const month = months[d.getMonth()];
      const day = d.getDate();
      let hours = d.getHours();
      const mins = String(d.getMinutes()).padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12 || 12;
      return `${month} ${day}, ${hours}:${mins} ${ampm}`;
    } catch {
      return isoString;
    }
  }

  /**
   * Append a journal entry to soma_journal.json and rebuild soma_journal.md.
   * Uses async fs.writeFile to avoid blocking the cycle.
   */
  _appendJournalEntry(entry) {
    // Read existing journal (sync is fine here — small file, done at cycle end)
    let entries = [];
    try {
      if (fs.existsSync(SOMA_JOURNAL_JSON)) {
        entries = JSON.parse(fs.readFileSync(SOMA_JOURNAL_JSON, 'utf8'));
        if (!Array.isArray(entries)) entries = [];
      }
    } catch {
      entries = [];
    }

    // Append new entry, trim to max
    entries.push(entry);
    if (entries.length > JOURNAL_MAX_ENTRIES) {
      entries = entries.slice(entries.length - JOURNAL_MAX_ENTRIES);
    }

    // Write JSON (async — don't block the cycle)
    const jsonStr = JSON.stringify(entries, null, 2);
    fs.writeFile(SOMA_JOURNAL_JSON, jsonStr, (err) => {
      if (err) console.error(`[Journal] JSON write error: ${err.message}`);
    });

    // Rebuild markdown from the trimmed entries, newest first, last 48
    const mdEntries = entries.slice(-JOURNAL_MD_ENTRIES).reverse();
    const mdLines = ['# Soma Journal', ''];
    for (const e of mdEntries) {
      const dateStr = this._formatCycleDate(e.timestamp);
      const typeLabel = e.cycleType === 'deep-think' ? ' (deep think)' : '';
      const awayStr = e.elapsedSinceUser && e.elapsedSinceUser !== 'unknown' && e.elapsedSinceUser !== 'active'
        ? ` — ${e.elapsedSinceUser} since last session`
        : '';
      mdLines.push(`## Cycle ${e.cycleNum}${typeLabel} — ${dateStr}${awayStr}`);
      mdLines.push(e.narrative);
      mdLines.push('');
    }

    const mdStr = mdLines.join('\n');
    fs.writeFile(SOMA_JOURNAL_MD, mdStr, (err) => {
      if (err) console.error(`[Journal] MD write error: ${err.message}`);
    });
  }

  /**
   * Human-readable duration from milliseconds.
   * Duplicated here so it's self-contained (briefing.js has its own copy).
   */
  _humanDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }

  // ── Status ──────────────────────────────────────────────────

  sessionStatus() {
    return {
      activeSession: this.claudeSession?.status() || null,
      recentSessions: this.sessionHistory.slice(-5),
      pendingSignals: this.pendingSignals.length,
      totalSessionsRun: this.sessionHistory.length,
      sensors: this.engine?.sensors ? {
        registered: this.engine.sensors.sensors.size,
        sensorNames: [...this.engine.sensors.sensors.keys()],
        intakeCount: this.engine.sensors.intake?.length || 0,
        pendingSensorSignals: this.pendingSignals.filter(s => s.type === 'sensor-finding').length
      } : null,
      actions: this.engine?.actions ? this.engine.actions.selfReport() : null,
      modelTiers: {
        deepThinkModel: DEEP_THINK_MODEL,
        routineModel: ROUTINE_MODEL,
        strategicBudget: this._checkModelBudget('strategic'),
        operationalBudget: this._checkModelBudget('operational')
      },
      safetyGate: {
        lastDeepThinkTime: this.lastDeepThinkTime,
        lastSessionEndTime: this.lastSessionEndTime,
        lastKnownSessionCount: this.lastKnownSessionCount,
        deepThinkCooldownRemaining: this.lastDeepThinkTime > 0
          ? Math.max(0, DEEP_THINK_COOLDOWN - (Date.now() - this.lastDeepThinkTime))
          : 0,
        sessionCooldownRemaining: this.lastSessionEndTime > 0
          ? Math.max(0, SESSION_END_BUFFER - (Date.now() - this.lastSessionEndTime))
          : 0
      }
    };
  }

  // ── Proactive Notifications ─────────────────────────────────
  //
  // Soma reaches out proactively without being asked.
  // Fire-and-forget: never blocks the cycle, never crashes on server-down.
  // Dedup: same type+subject won't fire more than once per 2 hours.
  //
  // @param {string} notifType  - Dedup key prefix (e.g. 'warmth-spike')
  // @param {string} subject    - Dedup key suffix (truncated title/id)
  // @param {string} message    - Human-readable message (<100 chars)
  // @param {string} level      - 'info' | 'warning' | 'insight'

  _notify(notifType, subject, message, level = 'info') {
    try {
      // Prune stale dedup entries (> 2 hours old)
      const TWO_HOURS = 2 * 60 * 60 * 1000;
      const now = Date.now();
      for (const [key, ts] of this._recentNotifications) {
        if (now - ts > TWO_HOURS) this._recentNotifications.delete(key);
      }

      // Check dedup
      const dedupKey = `${notifType}:${String(subject).slice(0, 80)}`;
      if (this._recentNotifications.has(dedupKey)) return; // already fired recently

      // Record before firing so even a sync error doesn't cause a duplicate
      this._recentNotifications.set(dedupKey, now);

      // Fire via addNotification (imported directly — no HTTP needed, no server-down risk)
      addNotification('soma', message.slice(0, 100), level);
      console.log(`[Soma] → Notified: "${message.slice(0, 100)}"`);
    } catch (err) {
      // Never crash the cycle
      console.warn(`[Soma] Notification error (non-fatal): ${err.message}`);
    }
  }

  async stop() {
    console.log('\n[Soma] Shutting down...');
    if (this.graphTimer) clearInterval(this.graphTimer);
    if (this.claudeSession?.active) {
      await this.claudeSession.close(); // also releases session lock
    }
    this.engine?.save();
    this._saveLog();
    console.log('[Soma] Saved. Goodbye.');
    process.exit(0);
  }
}

// ── CLI ───────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const graphInterval = parseInt(args[0]) || 60000;

  const daemon = new SomaDaemon({
    interval: graphInterval
  });

  // Crash safety — release lock if process dies unexpectedly
  const { releaseBackgroundLock } = require('./tools/session-lock');
  process.on('uncaughtException', (err) => {
    console.error('[Soma] UNCAUGHT EXCEPTION:', err.message);
    releaseBackgroundLock('soma');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[Soma] UNHANDLED REJECTION:', reason);
    releaseBackgroundLock('soma');
  });

  daemon.start().catch(err => {
    console.error('Fatal:', err);
    releaseBackgroundLock('soma');
    process.exit(1);
  });
}

module.exports = SomaDaemon;
