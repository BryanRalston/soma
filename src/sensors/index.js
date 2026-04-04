// ============================================================
// SOMA — Sensor Manager
// Orchestrates all sensors and the intake buffer.
// Called by the daemon on its sensing cycle.
//
// Architecture:
//   SensorManager
//     ├── sensors: Map<name, SensorBase>
//     ├── intake: IntakeBuffer (scores + buffers before KG)
//     └── state: persisted to sensor_state.json
//
// The daemon calls cycle() — sensors that are due will run,
// results flow through the intake buffer, and actionable items
// surface for the next graph cycle or deep think.
// ============================================================

const fs = require('fs').promises;
const path = require('path');
const IntakeBuffer = require('./intake-buffer');

let _config = {};
try { _config = require('../../soma.config.js'); } catch (_) {}
const DATA_DIR = process.env.SOMA_DATA || _config.dataDir || path.join(__dirname, '../../data');
const DEFAULT_STATE_FILE = path.join(DATA_DIR, 'sensor_state.json');

class SensorManager {
  constructor(knowledgeGraph, options = {}) {
    this.kg = knowledgeGraph;
    this.sensors = new Map();
    this.intake = new IntakeBuffer(knowledgeGraph, {
      bufferFile: options.bufferFile || path.join(DATA_DIR, 'intake_buffer.json')
    });
    this.stateFile = options.stateFile || DEFAULT_STATE_FILE;
    this.initialized = false;
  }

  register(sensor) {
    this.sensors.set(sensor.name, sensor);
    console.log(`[Sensors] Registered: ${sensor.name} (interval: ${(sensor.intervalMs / 3600000).toFixed(1)}h)`);
  }

  async initialize() {
    // Load intake buffer
    await this.intake.load();

    // Restore sensor state (lastRunAt, runCount, seenPMIDs, etc.)
    await this.loadState();

    // Register default sensors
    const PubMedSensor = require('./pubmed-sensor');
    this.register(new PubMedSensor());

    const GitHubSensor = require('./github-sensor');
    this.register(new GitHubSensor());

    const RSSSensor = require('./rss-sensor');
    this.register(new RSSSensor());

    // Apply any persisted state to newly registered sensors
    await this.loadState();

    this.initialized = true;
    console.log(`[Sensors] Initialized: ${this.sensors.size} sensor(s), ${this.intake.items.length} buffered items`);
  }

  // ── Sensing Cycle ──────────────────────────────────────────
  // Called by daemon. Runs any sensors that are due, ingests results.

  async cycle() {
    if (!this.initialized) {
      console.warn('[Sensors] Not initialized — skipping cycle');
      return { sensorsRun: [], totalIngested: 0, errors: [] };
    }

    const results = {
      sensorsRun: [],
      totalIngested: 0,
      totalFetched: 0,
      errors: []
    };

    for (const [name, sensor] of this.sensors) {
      if (!sensor.shouldRun()) continue;

      try {
        console.log(`[Sensors] Running ${name}...`);
        const items = await sensor.run();

        if (items && items.length > 0) {
          const ingested = await this.intake.ingest(name, items);
          results.sensorsRun.push(name);
          results.totalFetched += items.length;
          results.totalIngested += ingested.length;
          console.log(`[Sensors] ${name}: ${items.length} fetched, ${ingested.length} new`);
        } else {
          console.log(`[Sensors] ${name}: no new items`);
          results.sensorsRun.push(name);
        }
      } catch (err) {
        console.error(`[Sensors] ${name} error: ${err.message}`);
        results.errors.push({ sensor: name, error: err.message });
        // Record the error on the sensor for reporting
        sensor.lastError = err.message;
      }
    }

    // Save state after all sensors run
    if (results.sensorsRun.length > 0) {
      await this.saveState();
    }

    // Periodic buffer maintenance — prune old discards
    if (this.intake.items.length > 500) {
      const pruned = await this.intake.prune();
      if (pruned > 0) {
        console.log(`[Sensors] Pruned ${pruned} old discarded items from intake buffer`);
      }
    }

    return results;
  }

  // ── Accessors ──────────────────────────────────────────────

  getActionableIntake(minScore) {
    return this.intake.getActionable(minScore);
  }

  getSensor(name) {
    return this.sensors.get(name) || null;
  }

  // ── Intake Processing ─────────────────────────────────────
  // Process buffered intake items: promote high-relevance, discard stale low-relevance.
  // Can be called manually via API to flush the backlog.

  async processIntake(options = {}) {
    const maxPromote = options.maxPromote || 20;
    const promoteThreshold = options.promoteThreshold || 0.25;
    const discardStaleAfterDays = options.discardStaleAfterDays || 14;
    const maxAgeDays = options.maxAgeDays || 30;
    const now = Date.now();

    let promoted = 0;
    let skipped = 0;
    let discarded = 0;
    const promotedItems = [];

    // 1. Promote actionable items
    const actionable = this.intake.getActionable(promoteThreshold);
    console.log(`[Sensors] processIntake: ${this.intake.items.length} total, ${actionable.length} actionable (>= ${promoteThreshold})`);

    for (const item of actionable) {
      if (promoted >= maxPromote) break;

      // Skip items older than maxAge
      if (item.ingestedAt && (now - item.ingestedAt) > maxAgeDays * 86400000) {
        skipped++;
        continue;
      }

      // Skip if KG already has a node with this exact title
      const title = item.data?.title || '';
      if (title) {
        let duplicate = false;
        for (const node of this.kg.nodes.values()) {
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

      const result = await this.intake.promote(item.id);
      if (result) {
        promoted++;
        promotedItems.push({
          id: item.id,
          title: title.slice(0, 80),
          relevance: item.relevanceScore,
          nodeId: result.promotedNodeId
        });
      } else {
        skipped++;
      }
    }

    // 2. Discard stale low-relevance items
    const staleItems = this.intake.items.filter(i =>
      i.status === 'new' &&
      i.relevanceScore < promoteThreshold &&
      i.ingestedAt && (now - i.ingestedAt) > discardStaleAfterDays * 86400000
    );
    for (const item of staleItems) {
      await this.intake.discard(item.id);
      discarded++;
    }

    return { promoted, skipped, discarded, promotedItems, remaining: this.intake.getByStatus('new').length };
  }

  // ── Reporting ──────────────────────────────────────────────

  selfReport() {
    return {
      initialized: this.initialized,
      sensors: Array.from(this.sensors.values()).map(s => s.selfReport()),
      intake: this.intake.summary()
    };
  }

  // ── State Persistence ──────────────────────────────────────
  // Save/load each sensor's state so lastRunAt and seenPMIDs
  // survive daemon restarts.

  async saveState() {
    try {
      const state = {};
      for (const [name, sensor] of this.sensors) {
        state[name] = sensor.getState();
      }

      await fs.writeFile(this.stateFile, JSON.stringify({
        savedAt: Date.now(),
        sensors: state
      }, null, 2));
    } catch (err) {
      console.error(`[Sensors] State save error: ${err.message}`);
    }
  }

  async loadState() {
    try {
      const raw = await fs.readFile(this.stateFile, 'utf8');
      const data = JSON.parse(raw);
      const sensorStates = data.sensors || {};

      for (const [name, sensor] of this.sensors) {
        if (sensorStates[name]) {
          sensor.loadState(sensorStates[name]);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[Sensors] State load error: ${err.message}`);
      }
      // First run or corrupted — sensors start fresh
    }
  }
}

module.exports = SensorManager;
