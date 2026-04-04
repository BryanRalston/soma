// ============================================================
// CORTEX CORE — Tool Registry
// Pluggable tool system. Claude is just one tool among many.
// ============================================================

class ToolRegistry {
  constructor() {
    this.tools = new Map();     // name -> tool definition
    this.history = [];          // execution history
    this.stats = new Map();     // name -> { calls, failures, totalMs, tokensUsed }
  }

  // ── Registration ────────────────────────────────────────────

  register(tool) {
    if (!tool.name || !tool.execute) {
      throw new Error(`Tool must have 'name' and 'execute'. Got: ${JSON.stringify(Object.keys(tool))}`);
    }

    this.tools.set(tool.name, {
      name: tool.name,
      description: tool.description || '',
      category: tool.category || 'general',    // llm, search, filesystem, code, api
      cost: tool.cost || 'free',               // free, cheap, expensive
      capabilities: tool.capabilities || [],    // what it can do
      execute: tool.execute,                    // async (input, context) => output
      available: tool.available || (() => true), // () => boolean
      fallback: tool.fallback || null           // name of fallback tool
    });

    this.stats.set(tool.name, {
      calls: 0,
      failures: 0,
      totalMs: 0,
      tokensUsed: 0,
      lastUsed: null
    });

    return this;
  }

  unregister(name) {
    this.tools.delete(name);
    return this;
  }

  // ── Execution ───────────────────────────────────────────────

  async execute(toolName, input, context = {}) {
    const tool = this.tools.get(toolName);
    if (!tool) throw new Error(`Tool not found: ${toolName}`);

    // Check availability
    if (!tool.available()) {
      if (tool.fallback && this.tools.has(tool.fallback)) {
        return this.execute(tool.fallback, input, context);
      }
      throw new Error(`Tool unavailable: ${toolName} (no fallback)`);
    }

    const stats = this.stats.get(toolName);
    const startTime = Date.now();
    const entry = {
      tool: toolName,
      input: this._summarizeInput(input),
      startedAt: startTime,
      status: 'running'
    };

    try {
      const result = await tool.execute(input, context);
      const elapsed = Date.now() - startTime;

      stats.calls++;
      stats.totalMs += elapsed;
      stats.lastUsed = Date.now();
      if (result?.tokensUsed) stats.tokensUsed += result.tokensUsed;

      entry.status = 'success';
      entry.elapsed = elapsed;
      entry.outputPreview = this._summarizeOutput(result);
      this.history.push(entry);

      return result;
    } catch (err) {
      const elapsed = Date.now() - startTime;
      stats.calls++;
      stats.failures++;
      stats.totalMs += elapsed;

      entry.status = 'error';
      entry.error = err.message;
      entry.elapsed = elapsed;
      this.history.push(entry);

      // Try fallback
      if (tool.fallback && this.tools.has(tool.fallback)) {
        return this.execute(tool.fallback, input, context);
      }

      throw err;
    }
  }

  // ── Discovery ───────────────────────────────────────────────

  list() {
    return [...this.tools.values()].map(t => ({
      name: t.name,
      description: t.description,
      category: t.category,
      cost: t.cost,
      capabilities: t.capabilities,
      available: t.available()
    }));
  }

  findByCapability(capability) {
    return [...this.tools.values()]
      .filter(t => t.capabilities.includes(capability) && t.available())
      .sort((a, b) => {
        const costOrder = { free: 0, cheap: 1, expensive: 2 };
        return (costOrder[a.cost] || 0) - (costOrder[b.cost] || 0);
      });
  }

  findByCost(maxCost) {
    const costOrder = { free: 0, cheap: 1, expensive: 2 };
    const max = costOrder[maxCost] ?? 2;
    return [...this.tools.values()]
      .filter(t => (costOrder[t.cost] || 0) <= max && t.available());
  }

  // ── Smart Selection ─────────────────────────────────────────
  // Given a task description, pick the best tool

  selectTool(task) {
    const candidates = [...this.tools.values()].filter(t => t.available());
    if (candidates.length === 0) return null;

    // Score each tool
    const scored = candidates.map(tool => {
      let score = 0;

      // Capability match
      for (const cap of tool.capabilities) {
        if (task.requires && task.requires.includes(cap)) score += 10;
        if (task.description && task.description.toLowerCase().includes(cap)) score += 5;
      }

      // Cost preference (prefer cheaper)
      const costPenalty = { free: 0, cheap: 1, expensive: 3 };
      score -= (costPenalty[tool.cost] || 0);

      // Reliability (fewer failures = better)
      const stats = this.stats.get(tool.name);
      if (stats && stats.calls > 0) {
        const reliability = 1 - (stats.failures / stats.calls);
        score += reliability * 3;
      }

      // Category match
      if (task.category && tool.category === task.category) score += 5;

      return { tool, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.tool || null;
  }

  // ── Introspection ───────────────────────────────────────────

  getStats(toolName) {
    if (toolName) return this.stats.get(toolName);
    const all = {};
    for (const [name, stats] of this.stats) {
      all[name] = { ...stats, avgMs: stats.calls > 0 ? Math.round(stats.totalMs / stats.calls) : 0 };
    }
    return all;
  }

  recentHistory(limit = 20) {
    return this.history.slice(-limit);
  }

  selfReport() {
    const available = [...this.tools.values()].filter(t => t.available());
    const unavailable = [...this.tools.values()].filter(t => !t.available());

    return {
      totalTools: this.tools.size,
      available: available.map(t => t.name),
      unavailable: unavailable.map(t => t.name),
      categories: [...new Set([...this.tools.values()].map(t => t.category))],
      totalExecutions: this.history.length,
      stats: this.getStats(),
      recentHistory: this.recentHistory(5)
    };
  }

  // ── Private ─────────────────────────────────────────────────

  _summarizeInput(input) {
    if (typeof input === 'string') return input.slice(0, 200);
    if (typeof input === 'object') {
      const s = JSON.stringify(input);
      return s.length > 200 ? s.slice(0, 200) + '...' : s;
    }
    return String(input).slice(0, 200);
  }

  _summarizeOutput(output) {
    if (typeof output === 'string') return output.slice(0, 200);
    if (output?.text) return output.text.slice(0, 200);
    if (output?.result) return String(output.result).slice(0, 200);
    return '[object]';
  }
}

module.exports = ToolRegistry;
