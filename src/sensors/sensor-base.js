// ============================================================
// SOMA — Sensor Base Class
// The sensing layer. How Soma perceives the outside world.
//
// Subclasses implement fetch() and extract() to pull data from
// external sources. The base handles scheduling, state tracking,
// and the template method pattern for the run cycle.
// ============================================================

class SensorBase {
  constructor(name, config = {}) {
    this.name = name;
    this.config = config;
    this.lastRunAt = 0;
    this.runCount = 0;
    this.lastResults = null;
    this.lastError = null;
  }

  // Override in subclasses to set polling frequency
  get intervalMs() {
    return 24 * 60 * 60 * 1000; // default: daily
  }

  shouldRun() {
    return (Date.now() - this.lastRunAt) >= this.intervalMs;
  }

  // Subclass contract: fetch raw data from external source
  async fetch() {
    throw new Error('Subclass must implement fetch()');
  }

  // Subclass contract: transform raw data into structured items
  async extract(rawData) {
    throw new Error('Subclass must implement extract()');
  }

  // Template method — orchestrates the full sense cycle
  async run() {
    if (!this.shouldRun()) return null;

    this.lastError = null;
    const raw = await this.fetch();
    const extracted = await this.extract(raw);

    this.lastRunAt = Date.now();
    this.runCount++;
    this.lastResults = extracted;
    return extracted;
  }

  selfReport() {
    return {
      name: this.name,
      lastRunAt: this.lastRunAt,
      runCount: this.runCount,
      lastResultCount: this.lastResults?.length || 0,
      lastError: this.lastError,
      intervalMs: this.intervalMs,
      nextRunAt: this.lastRunAt + this.intervalMs
    };
  }

  // Serialize state for persistence between daemon restarts
  getState() {
    return {
      lastRunAt: this.lastRunAt,
      runCount: this.runCount
    };
  }

  loadState(state) {
    if (state) {
      this.lastRunAt = state.lastRunAt || 0;
      this.runCount = state.runCount || 0;
    }
  }
}

module.exports = SensorBase;
