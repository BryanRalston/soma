#!/usr/bin/env node
// ============================================================
// SOMA PULSE — Run-once graph cycle + deep think
// Designed for Windows Task Scheduler (every 30 min).
// Spins up, does one full sweep, deep thinks if warranted, exits.
// Zero RAM when not running.
// ============================================================

const { SomaEngine } = require('../core/index');
const { isLockedBy, addNotification, getActiveSessions } = require('../tools/session-lock');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

let _config = {};
try { _config = require('../../soma.config.js'); } catch (_) {}
const DATA_DIR = process.env.SOMA_DATA || _config.dataDir || path.join(__dirname, '../../data');
const SIGNALS_FILE = path.join(DATA_DIR, 'thinking_signals.json');
const LOG_FILE = path.join(DATA_DIR, 'soma_core_log.json');
const PULSE_STATE_FILE = path.join(DATA_DIR, 'pulse_state.json');
const GOALS_FILE = path.join(DATA_DIR, 'goals.json');

// Safety constants (same as daemon)
const SESSION_END_BUFFER = 30 * 60 * 1000;
const DEEP_THINK_COOLDOWN = 30 * 60 * 1000;
const MEMORY_THRESHOLD = 0.90;  // Higher than daemon — pulse is transient, exits in seconds

// ── Pulse State (persists between runs) ──────────────────────

function loadPulseState() {
  try {
    if (fs.existsSync(PULSE_STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(PULSE_STATE_FILE, 'utf8'));
      // Ensure new fields exist
      if (!state.seenInsights) state.seenInsights = [];
      if (!state.seenInferences) state.seenInferences = [];
      if (!state.lastGoalIndex) state.lastGoalIndex = 0;
      return state;
    }
  } catch {}
  return { totalCycles: 0, lastDeepThinkTime: 0, lastRunTime: 0, seenInsights: [], seenInferences: [], lastGoalIndex: 0 };
}

function savePulseState(state) {
  try {
    fs.writeFileSync(PULSE_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[Pulse] Failed to save state: ${err.message}`);
  }
}

// ── Safety Gate (same logic as daemon) ───────────────────────

function safetyGateOpen(state) {
  // 1. No active user sessions
  try {
    const sessions = getActiveSessions();
    if (sessions.length > 0) {
      console.log(`[SafetyGate] BLOCKED: ${sessions.length} active user session(s)`);
      return false;
    }
  } catch (err) {
    console.log(`[SafetyGate] BLOCKED: Session check failed (${err.message})`);
    return false;
  }

  // 2. System memory below threshold
  try {
    const usedRatio = (os.totalmem() - os.freemem()) / os.totalmem();
    if (usedRatio >= MEMORY_THRESHOLD) {
      console.log(`[SafetyGate] BLOCKED: Memory at ${(usedRatio * 100).toFixed(1)}%`);
      return false;
    }
  } catch (err) {
    console.log(`[SafetyGate] BLOCKED: Memory check failed`);
    return false;
  }

  // 3. No interactive claude.exe processes
  try {
    const output = execSync(
      'powershell -NoProfile -c "Get-CimInstance Win32_Process -Filter \\"Name=\'claude.exe\'\\" | Select-Object -ExpandProperty CommandLine"',
      { timeout: 8000, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const lines = output.trim().split('\n').filter(l => l.trim());
    const BACKGROUND_PATTERNS = ['remote-control', '--daemon', '--background'];
    const interactive = lines.filter(cmd =>
      !BACKGROUND_PATTERNS.some(p => cmd.includes(p))
    );
    if (interactive.length > 0) {
      console.log(`[SafetyGate] BLOCKED: ${interactive.length} interactive claude.exe process(es)`);
      return false;
    }
  } catch (err) {
    // No claude.exe at all — that's fine
    if (!err.message?.includes('No instances')) {
      // Genuine error — fail safe
      console.log(`[SafetyGate] BLOCKED: Process check failed (${err.message})`);
      return false;
    }
  }

  // 4. Deep think cooldown
  if (state.lastDeepThinkTime > 0) {
    const elapsed = Date.now() - state.lastDeepThinkTime;
    if (elapsed < DEEP_THINK_COOLDOWN) {
      const remain = ((DEEP_THINK_COOLDOWN - elapsed) / 60000).toFixed(1);
      console.log(`[SafetyGate] BLOCKED: Last deep think ${(elapsed / 60000).toFixed(1)}min ago — need ${remain}min more`);
      return false;
    }
  }

  console.log(`[SafetyGate] ALL CLEAR — gate open`);
  return true;
}

// ── Intake Promotion ────────────────────────────────────────
// Promote high-relevance intake items into the KG, discard stale low-relevance ones.
// Mirrors daemon._promoteIntakeItems() but as a standalone function.

async function promoteIntakeItems(engine) {
  if (!engine?.sensors) return { promoted: 0, skipped: 0, discarded: 0 };

  const MAX_PER_CYCLE = 10;  // Higher than daemon (5) since pulse runs less frequently
  const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const DISCARD_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days for low-relevance items
  const PROMOTE_THRESHOLD = 0.25; // Slightly lower than daemon (0.3) to catch borderline items
  const now = Date.now();

  let promoted = 0;
  let skipped = 0;
  let discarded = 0;

  try {
    const intake = engine.sensors.intake;
    const actionable = intake.getActionable(PROMOTE_THRESHOLD);
    console.log(`[Pulse] Intake: ${intake.items.length} total, ${actionable.length} actionable (>= ${PROMOTE_THRESHOLD})`);

    for (const item of actionable) {
      if (promoted >= MAX_PER_CYCLE) break;

      // Skip items older than 30 days
      if (item.ingestedAt && (now - item.ingestedAt) > MAX_AGE_MS) {
        skipped++;
        continue;
      }

      // Skip if KG already has a node with this exact title
      const title = item.data?.title || '';
      if (title) {
        let duplicate = false;
        for (const node of engine.kg.nodes.values()) {
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
      const result = await intake.promote(item.id);
      if (result) {
        promoted++;
        console.log(`[Pulse] Promoted: "${(title || item.id).slice(0, 70)}" (relevance: ${item.relevanceScore.toFixed(3)})`);
      } else {
        skipped++;
      }
    }

    // Discard old low-relevance items that have been sitting untouched
    const staleItems = intake.items.filter(i =>
      i.status === 'new' &&
      i.relevanceScore < PROMOTE_THRESHOLD &&
      i.ingestedAt && (now - i.ingestedAt) > DISCARD_AGE_MS
    );
    for (const item of staleItems) {
      await intake.discard(item.id);
      discarded++;
    }
    if (discarded > 0) {
      console.log(`[Pulse] Discarded ${discarded} stale low-relevance intake items`);
    }
  } catch (err) {
    console.error(`[Pulse] Intake promotion error: ${err.message}`);
  }

  return { promoted, skipped, discarded };
}

// ── Deep Think Evaluation ────────────────────────────────────

function needsDeepThink(insights, pendingSignals) {
  const highPriority = (insights || []).filter(i => i.priority === 'high');
  if (highPriority.length >= 2) {
    return { needed: true, reason: `${highPriority.length} high-priority insights` };
  }
  if ((pendingSignals || []).length >= 5) {
    return { needed: true, reason: `${pendingSignals.length} pending signals` };
  }
  return { needed: false };
}

// ── Goal Injection ──────────────────────────────────────────

/**
 * Load active goals and pick 1-2 for this cycle's focus.
 * Rotates through goals across cycles so each gets attention.
 */
function selectGoalsForCycle(state) {
  try {
    if (!fs.existsSync(GOALS_FILE)) return { goals: [], injected: [] };
    const raw = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8'));
    const allGoals = Array.isArray(raw) ? raw : (raw.goals || []);
    const activeGoals = allGoals.filter(g => g.status === 'active');
    if (activeGoals.length === 0) return { goals: allGoals, injected: [] };

    // Pick 1-2 goals, rotating through the list
    const startIdx = (state.lastGoalIndex || 0) % activeGoals.length;
    const injected = [activeGoals[startIdx]];
    if (activeGoals.length > 1) {
      injected.push(activeGoals[(startIdx + 1) % activeGoals.length]);
    }

    // Advance the rotation index for next cycle
    state.lastGoalIndex = (startIdx + 1) % activeGoals.length;

    return { goals: allGoals, injected };
  } catch (err) {
    console.error(`[Pulse] Goal loading error: ${err.message}`);
    return { goals: [], injected: [] };
  }
}

/**
 * Build a goal-framing prompt that directs the reasoner to think outward.
 * This gets logged and could be used to seed directed thinking.
 */
function buildGoalContext(injectedGoals) {
  if (injectedGoals.length === 0) return null;
  const lines = injectedGoals.map(g => {
    const milestonesDone = (g.milestones || []).filter(m => m.done).length;
    const milestonesTotal = (g.milestones || []).length;
    const nextMilestone = (g.milestones || []).find(m => !m.done);
    return `  - "${g.title}" [${g.horizon}] (${milestonesDone}/${milestonesTotal} milestones)` +
      (nextMilestone ? `\n    Next: ${nextMilestone.text || nextMilestone.title}` : '');
  });
  return {
    summary: `Focus goals this cycle:\n${lines.join('\n')}`,
    goalIds: injectedGoals.map(g => g.id),
    goalTitles: injectedGoals.map(g => g.title)
  };
}

// ── Main Pulse ───────────────────────────────────────────────

async function pulse() {
  const t0 = Date.now();
  const state = loadPulseState();
  state.totalCycles++;

  console.log(`\n[Soma Pulse] Cycle ${state.totalCycles} starting at ${new Date().toLocaleTimeString()}`);

  // Boot engine
  let engine;
  try {
    engine = new SomaEngine({ verbose: false });
    await engine.initialize();
    // Count edges from adjacency map
    let edgeCount = 0;
    if (engine.kg?.adjacency) {
      for (const [, targets] of engine.kg.adjacency) edgeCount += targets.size || 0;
    }
    console.log(`[Pulse] Engine loaded: ${engine.kg?.nodes?.size || 0} nodes, ${edgeCount} edges`);
  } catch (err) {
    console.error(`[Pulse] Engine init failed: ${err.message}`);
    state.lastRunTime = Date.now();
    savePulseState(state);
    process.exit(1);
  }

  const eventParts = [];
  let goalContext = null;

  try {
    // 0. Goal injection — pick focus goals for this cycle
    const { injected: injectedGoals } = selectGoalsForCycle(state);
    goalContext = buildGoalContext(injectedGoals);
    if (goalContext) {
      console.log(`[Pulse] Goal focus: ${goalContext.goalTitles.join(', ')}`);
    }

    // 0b. Load dedup state — restore seen insight/inference keys from previous cycles
    engine.reasoner.loadSeenKeys(state.seenInsights, state.seenInferences);

    // 1. Self-maintain
    const maintenance = engine._selfMaintain();
    if (maintenance !== 'No maintenance needed.') eventParts.push(maintenance);

    // 2. Read signals
    let pendingSignals = [];
    try {
      const raw = fs.existsSync(SIGNALS_FILE)
        ? JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8'))
        : { signals: [] };
      pendingSignals = (Array.isArray(raw) ? raw : (raw.signals || [])).filter(s => s.status === 'pending');
    } catch {}

    // 3. Insights (with deduplication)
    const insights = engine.reasoner.generateInsights();
    const newInsightCount = insights._newCount || 0;
    const totalInsightsSeen = insights._totalSeen || insights.length;
    if (newInsightCount > 0) {
      eventParts.push(`${newInsightCount} new insights (${totalInsightsSeen} total seen)`);
    } else if (insights.length > 0) {
      eventParts.push(`${insights.length} insights (all previously seen)`);
    }

    // 4. Forward chain (with deduplication)
    const inferences = engine.reasoner.forwardChain(3);
    const newInferenceCount = inferences._newCount || 0;
    const totalInferencesSeen = inferences._totalSeen || inferences.length;
    if (newInferenceCount > 0) {
      eventParts.push(`${newInferenceCount} new inferences (${totalInferencesSeen} total seen)`);
    } else if (inferences.length > 0) {
      eventParts.push(`${inferences.length} inferences (all previously seen)`);
    }

    // 5. Learning (always run in pulse — no modulo gating)
    if (engine.learner) {
      try {
        const corrections = engine.learner.applyCorrections();
        const newRules = engine.learner.learnRules();
        const newHyp = engine.learner.generateHypotheses();
        const hypEval = engine.learner.evaluateHypothesesBatch();
        if (newRules.length > 0) eventParts.push(`${newRules.length} rules learned`);
        if (newHyp.length > 0) eventParts.push(`${newHyp.length} hypotheses`);
        if (hypEval?.evaluated > 0) eventParts.push(`${hypEval.evaluated} hyp evaluated`);
      } catch (err) {
        console.error(`[Pulse] Learner error: ${err.message}`);
      }
    }

    // 6. Consolidation
    if (engine.consolidator) {
      try {
        const c = engine.consolidator.processNewSessions();
        if (c.processed > 0) eventParts.push(`${c.processed} episodes consolidated`);
        const p = engine.consolidator.detectPatterns();
        if (p.new > 0) eventParts.push(`${p.new} cross-session patterns`);
      } catch (err) {
        console.error(`[Pulse] Consolidator error: ${err.message}`);
      }
    }

    // 7. Associator
    if (engine.associator) {
      try {
        const assoc = engine.associator.analyze();
        const findings = assoc.summary?.totalFindings || 0;
        if (findings > 0) eventParts.push(`${findings} associations`);
      } catch (err) {
        console.error(`[Pulse] Associator error: ${err.message}`);
      }
    }

    // 8. Sensors
    if (engine.sensors) {
      try {
        const sr = await engine.sensors.cycle();
        if (sr.totalIngested > 0) {
          eventParts.push(`${sr.totalIngested} sensor items from ${sr.sensorsRun.join(', ')}`);
          const actionable = engine.sensors.getActionableIntake(0.3);
          for (const item of actionable.slice(0, 5)) {
            pendingSignals.push({
              type: 'sensor-finding',
              priority: item.relevanceScore > 0.6 ? 'high' : 'medium',
              source: item.source,
              title: item.data?.title || 'Sensor finding',
              timestamp: Date.now()
            });
          }
        }
      } catch (err) {
        console.error(`[Pulse] Sensors error: ${err.message}`);
      }
    }

    // 8b. Intake promotion — push high-relevance intake items into the KG
    if (engine.sensors) {
      try {
        const promotion = await promoteIntakeItems(engine);
        if (promotion.promoted > 0) {
          eventParts.push(`${promotion.promoted} intake promoted to KG`);
        }
        if (promotion.discarded > 0) {
          eventParts.push(`${promotion.discarded} low-relevance intake discarded`);
        }
      } catch (err) {
        console.error(`[Pulse] Intake promotion error: ${err.message}`);
      }
    }

    // 9. Anomaly detection
    if (engine.learner && engine.patterns) {
      try {
        const anomalies = engine.patterns.detectAnomalies();
        if (anomalies.length > 0) {
          const al = engine.learner.learnFromAnomalies(anomalies);
          if (al.hypothesesCreated > 0) eventParts.push(`${al.hypothesesCreated} anomaly hypotheses`);
        }
      } catch (err) {
        console.error(`[Pulse] Anomaly detection error: ${err.message}`);
      }
    }

    // Save graph state after processing
    engine.save();

    const elapsed = Date.now() - t0;
    console.log(`[Pulse] Graph sweep: ${elapsed}ms — ${eventParts.join('; ') || 'quiet cycle'}`);

    // ── Deep Think Evaluation ──────────────────────────────
    const worth = needsDeepThink(insights, pendingSignals);
    if (worth.needed) {
      console.log(`[Pulse] Deep think warranted: ${worth.reason}`);
      if (safetyGateOpen(state)) {
        console.log(`[Pulse] Executing deep think...`);
        try {
          // Run reflection (zero-token engine work)
          const result = await engine.reflect();
          const output = result.phases?.act?.output || 'No output';
          console.log(`[Pulse] Reflection: ${output.split('\n')[0].slice(0, 120)}`);

          // Pattern analysis
          const patterns = engine.patterns.analyze({ windowDays: 7 });
          if (patterns.anomalies?.length > 0) {
            console.log(`[Pulse] ${patterns.anomalies.length} anomalies detected`);
          }

          state.lastDeepThinkTime = Date.now();
          console.log(`[Pulse] Deep think complete`);

          // Save after thinking
          engine.save();
        } catch (err) {
          console.error(`[Pulse] Deep think error: ${err.message}`);
          state.lastDeepThinkTime = Date.now(); // prevent rapid retries
        }
      } else {
        addNotification('soma', `Pulse: deferred deep think (${worth.reason}) — safety gate closed`, 'throttled');
      }
    } else {
      console.log(`[Pulse] No deep think needed this cycle`);
    }

  } catch (err) {
    console.error(`[Pulse] Cycle error: ${err.message}`);
  }

  // Persist dedup state back to pulse_state so next cycle knows what's been seen
  try {
    const seenKeys = engine.reasoner.exportSeenKeys();
    // Cap the seen sets to prevent unbounded growth (keep last 2000 of each)
    state.seenInsights = seenKeys.seenInsights.slice(-2000);
    state.seenInferences = seenKeys.seenInferences.slice(-2000);
  } catch {}

  // Log the cycle
  try {
    let log = [];
    if (fs.existsSync(LOG_FILE)) {
      log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
      if (!Array.isArray(log)) log = log.entries || [];
    }
    log.push({
      cycle: state.totalCycles,
      type: 'pulse',
      event: 'pulse-cycle',
      message: eventParts.join('; ') || 'quiet cycle',
      timestamp: Date.now(),
      elapsed: Date.now() - t0,
      goalFocus: goalContext ? goalContext.goalTitles : null
    });
    // Keep last 500 entries
    if (log.length > 500) log = log.slice(-500);
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  } catch {}

  state.lastRunTime = Date.now();
  savePulseState(state);

  const totalElapsed = Date.now() - t0;
  console.log(`[Soma Pulse] Done in ${totalElapsed}ms. Exiting.\n`);
  process.exit(0);
}

// Run
pulse().catch(err => {
  console.error(`[Pulse] Fatal: ${err.message}`);
  process.exit(1);
});
