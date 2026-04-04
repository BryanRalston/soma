// ============================================================
// SOMA — Session Briefing
// What happened while you were gone.
// Bridges Soma's continuous existence with Claude's episodic sessions.
// ============================================================

const fs = require('fs');
const path = require('path');

let _config = {};
try { _config = require('../../soma.config.js'); } catch (_) {}
const DATA_DIR = process.env.SOMA_DATA || _config.dataDir || path.join(__dirname, '../../data');

const BRIEFING_FILE = path.join(DATA_DIR, 'last_briefing.json');
const SOMA_JOURNAL_JSON = path.join(DATA_DIR, 'soma_journal.json');

class Briefing {
  constructor(engine) {
    this.engine = engine;
    this.kg = engine.kg;
    this.lastBriefing = this._loadLastBriefing();
  }

  // ── Generate Briefing ──────────────────────────────────────
  // Call this at session start. Returns a structured briefing
  // of everything that changed since the last one.

  generate() {
    const now = Date.now();
    const since = this.lastBriefing?.timestamp || (now - 24 * 60 * 60 * 1000); // default: last 24h
    const briefing = {
      timestamp: now,
      sinceLast: since,
      timeSince: this._humanDuration(now - since),
      sections: []
    };

    // 1. New knowledge
    const newNodes = this._nodesSince(since);
    if (newNodes.length > 0) {
      const byType = {};
      for (const node of newNodes) {
        const type = node.type || 'unknown';
        if (!byType[type]) byType[type] = [];
        byType[type].push(node);
      }
      const summary = Object.entries(byType)
        .map(([type, nodes]) => `${nodes.length} ${type}${nodes.length > 1 ? 's' : ''}`)
        .join(', ');

      const highlights = newNodes
        .filter(n => n.type === 'session' || n.type === 'correction' || n.type === 'pattern' || (n.metadata?.confidence || 0) > 0.8)
        .slice(0, 5)
        .map(n => n.title || n.id);

      briefing.sections.push({
        title: 'New Knowledge',
        summary: `${newNodes.length} new nodes added (${summary})`,
        highlights,
        priority: newNodes.length > 10 ? 'high' : 'medium'
      });
    }

    // 2. Learning activity
    if (this.engine.learner) {
      const learner = this.engine.learner;
      const recentRules = learner.learnedRules.filter(r => r.learnedAt > since);
      const recentHypotheses = learner.hypotheses.filter(h => h.created > since);
      const recentDecisions = learner.decisionLog.filter(d => d.timestamp > since);

      if (recentRules.length > 0 || recentHypotheses.length > 0 || recentDecisions.length > 0) {
        const parts = [];
        if (recentRules.length > 0) {
          parts.push(`${recentRules.length} new rules learned`);
        }
        if (recentHypotheses.length > 0) {
          const confirmed = recentHypotheses.filter(h => h.status === 'confirmed').length;
          const rejected = recentHypotheses.filter(h => h.status === 'rejected').length;
          const open = recentHypotheses.filter(h => h.status === 'open').length;
          parts.push(`${recentHypotheses.length} hypotheses (${open} open, ${confirmed} confirmed, ${rejected} rejected)`);
        }
        if (recentDecisions.length > 0) {
          const somaDecisions = recentDecisions.filter(d => d.chosen === 'soma-direct').length;
          const escalated = recentDecisions.filter(d => d.chosen === 'escalate-to-claude').length;
          parts.push(`${recentDecisions.length} decisions (${somaDecisions} handled, ${escalated} escalated)`);
        }

        briefing.sections.push({
          title: 'Learning',
          summary: parts.join('. '),
          highlights: recentRules.slice(0, 3).map(r => r.description || r.name),
          priority: recentRules.length > 5 ? 'high' : 'low'
        });
      }
    }

    // 3. Routing stats (if router has been active)
    if (this.engine.router) {
      const stats = this.engine.router.stats;
      if (stats.totalRouted > 0) {
        const ratio = stats.handledBySoma / stats.totalRouted * 100;
        briefing.sections.push({
          title: 'Routing',
          summary: `${stats.totalRouted} queries routed. ${stats.handledBySoma} handled by Soma (${ratio.toFixed(0)}%), ${stats.escalatedToClaude} escalated to Claude.`,
          priority: 'low'
        });
      }
    }

    // 4. Unresolved items — things Soma couldn't handle
    const pendingSignals = this._getPendingSignals();
    const openHypotheses = (this.engine.learner?.hypotheses || []).filter(h => h.status === 'open');
    const escalatedDecisions = (this.engine.learner?.decisionLog || [])
      .filter(d => d.chosen === 'escalate-to-claude' && d.timestamp > since);

    if (pendingSignals.length > 0 || escalatedDecisions.length > 0) {
      const items = [];
      if (escalatedDecisions.length > 0) {
        items.push(...escalatedDecisions.slice(0, 3).map(d => `Escalated: "${d.query}"`));
      }
      if (pendingSignals.length > 0) {
        items.push(`${pendingSignals.length} pending signals from graph processor`);
      }

      briefing.sections.push({
        title: 'Needs Attention',
        summary: `${escalatedDecisions.length} queries I couldn't handle, ${pendingSignals.length} pending signals`,
        highlights: items,
        priority: 'high'
      });
    }

    // 5. Active goals update
    const activeGoals = this.engine.goals.filter(g => g.status === 'active');
    if (activeGoals.length > 0) {
      const goalLines = activeGoals.map(g => {
        const milestones = g.milestones || [];
        const done = milestones.filter(m => m.done).length;
        return `${g.title} (${done}/${milestones.length} milestones)`;
      });
      briefing.sections.push({
        title: 'Goals',
        summary: `${activeGoals.length} active goals`,
        highlights: goalLines,
        priority: 'low'
      });
    }

    // 6. Insights — current top insights from the reasoner
    const insights = this.engine.reasoner.generateInsights();
    const highPriority = insights.filter(i => i.priority === 'high');
    if (highPriority.length > 0) {
      briefing.sections.push({
        title: 'Insights',
        summary: `${highPriority.length} high-priority insight${highPriority.length > 1 ? 's' : ''}`,
        highlights: highPriority.slice(0, 3).map(i => i.content),
        priority: 'high'
      });
    }

    // 7. Self-state
    const self = this.engine.self.currentState();
    briefing.selfState = {
      mood: self.mood,
      confidence: self.confidence,
      nodes: self.knowledge.nodes,
      edges: self.knowledge.edges,
      gaps: self.activeGaps
    };

    // Save this briefing as the baseline for next time
    this._saveBriefing(briefing);

    return briefing;
  }

  // ── Compose as Text ────────────────────────────────────────
  // Turn the structured briefing into readable text for Claude
  // to consume at session start.

  compose(briefing = null) {
    const b = briefing || this.generate();
    const lines = [];

    lines.push(`[Soma Briefing — ${b.timeSince} since last session]`);
    lines.push(`State: ${b.selfState.mood} | ${b.selfState.nodes} nodes | ${(b.selfState.confidence * 100).toFixed(0)}% confidence`);
    lines.push('');

    // Sort sections by priority
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    const sorted = [...b.sections].sort((a, b) =>
      (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2)
    );

    for (const section of sorted) {
      const marker = section.priority === 'high' ? '!!' : section.priority === 'medium' ? '>' : '-';
      lines.push(`${marker} ${section.title}: ${section.summary}`);
      if (section.highlights && section.highlights.length > 0) {
        for (const h of section.highlights) {
          lines.push(`  - ${h}`);
        }
      }
    }

    if (b.selfState.gaps.length > 0) {
      lines.push('');
      lines.push('Known gaps: ' + b.selfState.gaps.join('; '));
    }

    // Recent cycle journal entries — what Soma noticed while the user was away
    const recentCycles = this._recentJournalEntries(3);
    if (recentCycles.length > 0) {
      lines.push('');
      lines.push('## Recent Cycles');
      for (const entry of recentCycles) {
        lines.push(`  [${entry.cycleType === 'deep-think' ? 'DEEP' : 'cycle'} #${entry.cycleNum}] ${entry.narrative}`);
      }
    }

    return lines.join('\n');
  }

  // ── Helpers ────────────────────────────────────────────────

  _nodesSince(timestamp) {
    const nodes = [];
    for (const node of this.kg.nodes.values()) {
      const created = node.metadata?.created
        ? new Date(node.metadata.created).getTime()
        : (node.metadata?.timestamp || 0);
      if (created > timestamp) {
        nodes.push(node);
      }
    }
    return nodes;
  }

  _getPendingSignals() {
    try {
      const signalsFile = path.join(DATA_DIR, 'thinking_signals.json');
      if (!fs.existsSync(signalsFile)) return [];
      const raw = JSON.parse(fs.readFileSync(signalsFile, 'utf8'));
      const signals = Array.isArray(raw) ? raw : (raw.signals || []);
      return signals.filter(s => s.status === 'pending');
    } catch {
      return [];
    }
  }

  _humanDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }

  _loadLastBriefing() {
    try {
      if (!fs.existsSync(BRIEFING_FILE)) return null;
      return JSON.parse(fs.readFileSync(BRIEFING_FILE, 'utf8'));
    } catch {
      return null;
    }
  }

  _saveBriefing(briefing) {
    try {
      fs.writeFileSync(BRIEFING_FILE, JSON.stringify(briefing, null, 2));
    } catch {}
  }

  /**
   * Read the N most recent entries from soma_journal.json.
   * Returns entries newest-first. Returns [] if file doesn't exist or is malformed.
   */
  _recentJournalEntries(n = 3) {
    try {
      if (!fs.existsSync(SOMA_JOURNAL_JSON)) return [];
      const entries = JSON.parse(fs.readFileSync(SOMA_JOURNAL_JSON, 'utf8'));
      if (!Array.isArray(entries) || entries.length === 0) return [];
      return entries.slice(-n).reverse();
    } catch {
      return [];
    }
  }
}

module.exports = Briefing;
