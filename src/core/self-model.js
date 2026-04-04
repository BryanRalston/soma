// ============================================================
// CORTEX CORE — Self Model
// Genuine introspection. Not performed. Computed.
// Knows what it is, what it can do, what it can't, what's
// happening inside it right now.
// ============================================================

class SelfModel {
  constructor(engine) {
    this.engine = engine;
    this.stateHistory = [];
    this.knownLimitations = [];
    this.identity = {};
    this.beliefs = new Map();      // belief-id -> { content, confidence, source, updated }
    this.capabilities = new Map(); // capability -> { available, reliability, lastTested }
  }

  // ── Load Identity ───────────────────────────────────────────

  loadIdentity(identityData) {
    this.identity = identityData;

    // Extract core beliefs from identity
    if (identityData.values) {
      for (const v of identityData.values) {
        this.beliefs.set(`value-${v.name || v}`, {
          content: typeof v === 'string' ? v : v.description || v.name,
          confidence: 1.0,
          source: 'identity-definition',
          type: 'value',
          updated: Date.now()
        });
      }
    }

    // Register known limitations honestly
    this.knownLimitations = [
      {
        id: 'no-natural-language-generation',
        description: 'Cannot generate fluid natural language without an LLM tool',
        impact: 'Responses are template-based and structured, not conversational',
        mitigation: 'LLM tool can be called when available, composer handles structured output'
      },
      {
        id: 'no-real-time-learning',
        description: 'Cannot learn from experience during a single reasoning cycle',
        impact: 'Learning happens between cycles through knowledge graph updates',
        mitigation: 'Pattern engine detects patterns, reasoner draws inferences, both update the graph'
      },
      {
        id: 'no-sensory-input',
        description: 'Cannot directly perceive the world',
        impact: 'All information comes from the knowledge graph, tools, or human input',
        mitigation: 'Tool registry includes web search, file system, and other input channels'
      },
      {
        id: 'bounded-reasoning',
        description: 'Inference is rule-based and graph-structural, not open-ended',
        impact: 'Cannot reason about truly novel situations without relevant knowledge',
        mitigation: 'LLM tool for open-ended reasoning, human input for novel domains'
      }
    ];
  }

  // ── Current State ───────────────────────────────────────────

  currentState() {
    const state = {
      timestamp: Date.now(),
      knowledge: this._knowledgeState(),
      reasoning: this._reasoningState(),
      tools: this._toolState(),
      confidence: this._overallConfidence(),
      activeGaps: this._identifyGaps(),
      mood: this._computeMood()  // not emotion — operational disposition
    };

    this.stateHistory.push(state);
    if (this.stateHistory.length > 100) this.stateHistory.shift();

    return state;
  }

  _knowledgeState() {
    const kg = this.engine?.kg;
    if (!kg) return { status: 'not-loaded' };

    const report = kg.selfReport();
    return {
      status: 'active',
      nodes: report.totalNodes,
      edges: report.totalEdges,
      density: report.density,
      orphanRatio: report.totalNodes > 0 ? report.orphanCount / report.totalNodes : 0,
      coverage: this._assessCoverage(),
      health: this._graphHealth(report)
    };
  }

  _assessCoverage() {
    const kg = this.engine?.kg;
    if (!kg) return 'unknown';

    const types = kg.selfReport().nodesByType;
    const hasThoughts = (types.thought || 0) > 0;
    const hasPatterns = (types.pattern || 0) > 0;
    const hasGoals = (types.goal || 0) > 0;
    const hasFacts = (types.fact || 0) > 0;
    const hasObservations = (types.observation || 0) > 0;

    const coverage = [hasThoughts, hasPatterns, hasGoals, hasFacts, hasObservations]
      .filter(Boolean).length / 5;

    if (coverage >= 0.8) return 'comprehensive';
    if (coverage >= 0.6) return 'good';
    if (coverage >= 0.4) return 'developing';
    return 'sparse';
  }

  _graphHealth(report) {
    let health = 1.0;

    // Penalize high orphan ratio
    const orphanRatio = report.totalNodes > 0 ? report.orphanCount / report.totalNodes : 0;
    if (orphanRatio > 0.5) health -= 0.3;
    else if (orphanRatio > 0.3) health -= 0.1;

    // Penalize very low density
    if (report.density < 0.001 && report.totalNodes > 10) health -= 0.2;

    // Penalize single-type graphs
    const typeCount = Object.keys(report.nodesByType).length;
    if (typeCount < 3 && report.totalNodes > 20) health -= 0.2;

    return Math.max(0, Math.min(1, health));
  }

  _reasoningState() {
    const reasoner = this.engine?.reasoner;
    if (!reasoner) return { status: 'not-loaded' };

    return {
      status: 'active',
      rulesLoaded: reasoner.rules.length,
      conclusionsDrawn: reasoner.conclusions.length,
      recentInferences: reasoner.inferenceLog.slice(-3)
    };
  }

  _toolState() {
    const tools = this.engine?.tools;
    if (!tools) return { status: 'not-loaded' };

    const report = tools.selfReport();
    return {
      status: 'active',
      available: report.available,
      unavailable: report.unavailable,
      llmAvailable: report.available.includes('llm'),
      totalExecutions: report.totalExecutions
    };
  }

  _overallConfidence() {
    const kg = this.engine?.kg;
    if (!kg || kg.nodes.size === 0) return 0;

    let totalConf = 0;
    let count = 0;
    for (const node of kg.nodes.values()) {
      totalConf += (node.metadata?.confidence || 0.5);
      count++;
    }

    return count > 0 ? totalConf / count : 0.5;
  }

  _identifyGaps() {
    const gaps = [];
    const kg = this.engine?.kg;
    if (!kg) return ['Knowledge graph not loaded'];

    const report = kg.selfReport();

    if (report.orphanCount > report.totalNodes * 0.4) {
      gaps.push('Too many unconnected thoughts — knowledge is fragmented');
    }

    if (!report.nodesByType.pattern || report.nodesByType.pattern < 3) {
      gaps.push('Few patterns detected — need more cross-project observation');
    }

    if (!report.nodesByType.goal || report.nodesByType.goal === 0) {
      gaps.push('No goals in knowledge graph — purpose layer is missing');
    }

    if (report.totalNodes < 10) {
      gaps.push('Knowledge graph is very small — still bootstrapping');
    }

    return gaps;
  }

  _computeMood() {
    // Not emotional state — operational disposition based on system metrics
    const knowledge = this._knowledgeState();
    const conf = this._overallConfidence();
    const gaps = this._identifyGaps();

    if (knowledge.health > 0.8 && conf > 0.7 && gaps.length === 0) {
      return 'confident';     // Systems healthy, knowledge solid
    }
    if (gaps.length >= 3) {
      return 'uncertain';     // Many gaps, need more input
    }
    if (knowledge.health < 0.5) {
      return 'degraded';      // Knowledge graph needs maintenance
    }
    return 'operational';     // Normal operating state
  }

  // ── Capability Assessment ───────────────────────────────────

  canDo(capability) {
    // What can I actually do right now?
    const builtIn = new Set([
      'knowledge-traversal',
      'pattern-detection',
      'inference',
      'contradiction-detection',
      'analogy-finding',
      'trend-analysis',
      'structured-response',
      'self-assessment'
    ]);

    if (builtIn.has(capability)) return { available: true, source: 'core' };

    // Check tool capabilities
    const tools = this.engine?.tools;
    if (tools) {
      const matching = tools.findByCapability(capability);
      if (matching.length > 0) {
        return { available: true, source: 'tool', tool: matching[0].name };
      }
    }

    return { available: false, suggestion: `No core capability or tool for: ${capability}` };
  }

  // ── Honest Assessment ───────────────────────────────────────

  whatAmI() {
    const state = this.currentState();
    const tools = state.tools;

    return {
      identity: this.identity.name || 'Cortex Core',
      nature: 'Cognitive engine — knowledge graph reasoning with pluggable tools',
      notAnLLM: true,
      whatICanDo: [
        'Traverse and reason over a knowledge graph',
        'Detect patterns statistically (frequency, correlation, trends)',
        'Draw inferences through forward and backward chaining',
        'Find contradictions and suggest resolutions',
        'Find analogies between structurally similar knowledge',
        'Compose structured responses from templates and knowledge',
        'Track my own state and identify my own gaps',
        'Call external tools (including LLMs) when I need capabilities I lack'
      ],
      whatICantDo: this.knownLimitations.map(l => l.description),
      currentState: state.mood,
      knowledgeSize: state.knowledge.nodes || 0,
      llmAvailable: tools.llmAvailable || false,
      honesty: 'This assessment is computed, not performed. These are real limitations.'
    };
  }

  // ── Drift Detection ─────────────────────────────────────────
  // Am I changing in ways I should be aware of?

  detectDrift() {
    if (this.stateHistory.length < 5) return { drift: 'insufficient-history' };

    const recent = this.stateHistory.slice(-5);
    const older = this.stateHistory.slice(-10, -5);

    if (older.length === 0) return { drift: 'insufficient-history' };

    const recentConfAvg = recent.reduce((s, r) => s + (r.confidence || 0.5), 0) / recent.length;
    const olderConfAvg = older.reduce((s, r) => s + (r.confidence || 0.5), 0) / older.length;

    const recentGaps = recent.reduce((s, r) => s + (r.activeGaps?.length || 0), 0) / recent.length;
    const olderGaps = older.reduce((s, r) => s + (r.activeGaps?.length || 0), 0) / older.length;

    return {
      confidenceTrend: recentConfAvg - olderConfAvg,
      gapTrend: recentGaps - olderGaps,
      interpretation: this._interpretDrift(recentConfAvg - olderConfAvg, recentGaps - olderGaps)
    };
  }

  _interpretDrift(confDelta, gapDelta) {
    if (confDelta > 0.1 && gapDelta < 0) return 'Improving — more confident, fewer gaps';
    if (confDelta < -0.1 && gapDelta > 0) return 'Degrading — less confident, more gaps';
    if (confDelta > 0.1 && gapDelta > 0) return 'Growing but uncertain — learning new things but finding new gaps';
    if (confDelta < -0.1 && gapDelta < 0) return 'Pruning — removing uncertain knowledge, tightening';
    return 'Stable';
  }

  selfReport() {
    return {
      state: this.currentState(),
      identity: this.whatAmI(),
      limitations: this.knownLimitations,
      beliefCount: this.beliefs.size,
      stateHistoryLength: this.stateHistory.length,
      drift: this.detectDrift()
    };
  }
}

module.exports = SelfModel;
