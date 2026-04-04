// ============================================================
// SOMA — Intent Router
// Understand what's being asked. Decide if Soma can handle it.
// The boundary between independence and escalation.
// ============================================================

// ── Cost Tier Mapping ─────────────────────────────────────────
// Four-tier model system: cheapest → most expensive
const COST_TIERS = {
  soma:   'free',        // Local graph reasoning — no API cost
  grok:   'tactical',    // Fast lookups, reviews, factual queries
  claude: 'operational', // Code editing, building, nuanced conversation
  mythos: 'strategic',   // Deep reasoning, identity work, cross-project synthesis
};

class Router {
  constructor(engine) {
    this.engine = engine;
    this.kg = engine.kg;
    this.routingLog = [];
    this.stats = {
      totalRouted: 0,
      handledBySoma: 0,
      escalatedToClaude: 0,
      byIntent: {}
    };
  }

  // ── Intent Classification ──────────────────────────────────
  // Finite set of intents. Pattern-match, not ML.

  classifyIntent(input) {
    const text = (input || '').toLowerCase().trim();
    if (!text) return { intent: 'empty', confidence: 1.0 };

    // Score each intent — highest wins
    const scores = [];

    for (const intent of Router.INTENTS) {
      let score = 0;

      // Keyword matching
      for (const kw of intent.keywords) {
        if (text.includes(kw)) {
          score += intent.keywordWeight || 0.3;
        }
      }

      // Pattern matching (regex)
      for (const pattern of (intent.patterns || [])) {
        if (pattern.test(text)) {
          score += intent.patternWeight || 0.5;
        }
      }

      // Structure matching
      if (intent.startsWithAny) {
        for (const prefix of intent.startsWithAny) {
          if (text.startsWith(prefix)) {
            score += 0.4;
            break;
          }
        }
      }

      if (intent.isQuestion && (text.includes('?') || /^(what|how|why|who|where|when|is|are|do|does|can|could|should|will|would)\s/i.test(text))) {
        score += 0.2;
      }

      scores.push({ intent: intent.name, score, handler: intent.handler });
    }

    scores.sort((a, b) => b.score - a.score);
    const best = scores[0];

    // Minimum threshold
    if (best.score < 0.2) {
      return { intent: 'unknown', confidence: best.score, original: text, candidates: scores.slice(0, 3) };
    }

    return {
      intent: best.intent,
      confidence: Math.min(1, best.score),
      handler: best.handler,
      original: text,
      alternatives: scores.slice(1, 3).filter(s => s.score > 0.15)
    };
  }

  // ── Entity Extraction ──────────────────────────────────────
  // Match known entities from the knowledge graph

  extractEntities(text) {
    const lower = text.toLowerCase();
    const entities = [];

    // Check goals
    for (const goal of (this.engine.goals || [])) {
      const title = (goal.title || '').toLowerCase();
      if (title && lower.includes(title.slice(0, 20).toLowerCase())) {
        entities.push({ type: 'goal', id: goal.id, title: goal.title, confidence: 0.9 });
      }
    }

    // Check known system names and any configured project names
    let _cfgProjectTags = [];
    try { _cfgProjectTags = require('../../soma.config.js').projectTags || []; } catch (_) {}

    const knownEntities = [
      { names: ['soma', 'cortex core', 'cortex-core', 'the engine', 'the mind'], type: 'system', id: 'soma-identity' },
      { names: ['thoughtstream', 'thoughts', 'thought graph'], type: 'system', id: 'thoughtstream' },
      { names: ['learning engine', 'learner', 'rules'], type: 'system', id: 'learner' },
      { names: ['grok', 'xai', 'grok-3'], type: 'model', id: 'grok-backend' },
      // Add your project-specific entities here, or they will be discovered via projectTags
      ...(_cfgProjectTags.map(tag => ({ names: [tag], type: 'project', id: tag }))),
    ];

    for (const entity of knownEntities) {
      for (const name of entity.names) {
        if (lower.includes(name)) {
          entities.push({ type: entity.type, id: entity.id, match: name, confidence: 0.85 });
          break;
        }
      }
    }

    return entities;
  }

  // ── Confidence Assessment ──────────────────────────────────
  // Can Soma handle this? The key question.

  assessConfidence(intent, entities, searchResults) {
    let confidence = 0;
    const reasons = [];

    // Base confidence from intent classification
    confidence += intent.confidence * 0.3;

    // Entity recognition boosts confidence
    if (entities.length > 0) {
      confidence += 0.2;
      reasons.push(`recognized ${entities.length} entities`);
    }

    // Search results quality
    if (searchResults && searchResults.length > 0) {
      const topRelevance = searchResults[0]?.relevance || searchResults[0]?.score || 0;
      if (topRelevance > 0.3) {
        confidence += 0.25;
        reasons.push(`strong graph match (${topRelevance.toFixed(2)})`);
      } else if (topRelevance > 0.15) {
        confidence += 0.1;
        reasons.push(`weak graph match (${topRelevance.toFixed(2)})`);
      }
    }

    // Intent-specific confidence adjustments
    switch (intent.intent) {
      case 'status-check':
      case 'self-query':
      case 'goal-query':
        confidence += 0.3; // Soma always knows its own state
        reasons.push('self-knowledge query');
        break;
      case 'knowledge-query':
        // Soma has graph data but LLMs explain better.
        // Only handle if it's clearly about Cortex internals.
        if (searchResults?.length >= 3) {
          const hasInternalEntity = entities.some(e => e.type === 'system' || e.type === 'tool');
          if (hasInternalEntity) {
            confidence += 0.15;
            reasons.push('internal knowledge query — soma has context');
          } else {
            confidence -= 0.1;
            reasons.push('general knowledge — LLM explains better');
          }
        }
        break;
      case 'pattern-query':
        confidence += 0.2; // Pattern engine is local
        reasons.push('pattern analysis is local');
        break;
      case 'creative-request':
      case 'code-request':
      case 'debug-request':
        confidence -= 0.3; // These need Claude
        reasons.push('requires language generation or code');
        break;
      case 'conversation':
        confidence -= 0.1; // Nuanced conversation needs Claude
        reasons.push('open-ended conversation');
        break;
    }

    // Learner decision memory — have we handled this before?
    if (this.engine.learner) {
      const similar = this.engine.learner.findSimilarDecisions(intent.original || '', [], 3);
      if (similar.length > 0) {
        const bestPast = similar[0];
        if (bestPast.decision.outcome?.success) {
          confidence += 0.15;
          reasons.push(`similar past decision succeeded`);
        } else {
          confidence -= 0.1;
          reasons.push(`similar past decision failed`);
        }
      }
    }

    confidence = Math.max(0, Math.min(1, confidence));

    return {
      confidence,
      canHandle: confidence >= 0.5,
      shouldEscalate: confidence < 0.35,
      reasons,
      recommendation: confidence >= 0.5 ? 'soma' :
                       confidence >= 0.35 ? 'soma-with-caveat' : 'claude'
    };
  }

  // ── Backend Selection ──────────────────────────────────────
  // When Soma can't handle it, which LLM should?
  // Key distinction: needs TOOLS (file access, commands) → Claude
  //                  needs ANALYSIS (review, knowledge, research) → Grok
  //                  needs BOTH perspectives → Collab

  recommendBackend(intent, entities, text) {
    const lower = (text || '').toLowerCase();
    const reasons = [];

    // Intent-based defaults
    const intentBackends = {
      'creative-request': 'claude',    // Building needs tools
      'knowledge-query':  'grok',      // General knowledge is Grok's strength
      'conversation':     'claude',    // Nuanced conversation
      'code-request':     'claude',    // Default, but overridden below for review
      'debug-request':    'claude',    // Default, but overridden below for analysis
      'status-check':     'soma',
      'self-query':       'soma',
      'goal-query':       'soma',
      'pattern-query':    'soma',
      'insight-query':    'soma',
      'learner-query':    'soma',
      'briefing-request': 'soma',
    };

    let backend = intentBackends[intent.intent] || 'claude';
    reasons.push(`intent "${intent.intent}" defaults to ${backend}`);

    // ── Signal-based overrides (order matters: later rules win) ──

    // Code REVIEW / bug finding → Grok (doesn't need tools, fresh perspective)
    const reviewSignals = /review|find\s*(bugs|issues|problems)|look\s*(at|over|through)|check\s*(this|my|the)\s*(code|logic|approach)|what('s| is) wrong|spot\s*(the|any)|audit|analyze\s*(this|the|my)\s*(code|function|class|module)|code\s*quality|improve\s*(this|the|my)\s*(code|logic)|suggestions?\s*(for|on)|critique|evaluate|assess|smell|anti.?pattern|vulnerability|security\s*(review|audit|check)|optimize/i;
    if (reviewSignals.test(text)) {
      backend = 'grok';
      reasons.push('code review / bug analysis → grok (fresh eyes, no tool bias)');
    }

    // Code EDITING / building → Claude (needs filesystem tools)
    const editSignals = /\b(fix|refactor|rewrite|update|modify|change|edit|add|remove|delete|replace|rename|move|create|implement|write|build)\s+(the|this|my|a|it|that)\b/i;
    if (editSignals.test(text) && !reviewSignals.test(text)) {
      backend = 'claude';
      reasons.push('code editing/building needs tools → claude');
    }

    // File/project signals → Claude (needs filesystem)
    const fileSignals = /[A-Z]:\\|\/[a-z]+\/|commit|branch|git\s|push|pull\s|deploy|run\s+(the|this|my|a)|start|launch|install|npm|node\s|execute/i;
    if (fileSignals.test(text)) {
      backend = 'claude';
      reasons.push('filesystem/command signals → claude');
    }

    // Cortex-internal entities → Claude (has CLAUDE.md context + tools)
    // UNLESS it's a review request (Grok reviewing our projects is valuable)
    const internalEntities = entities.filter(e =>
      e.type === 'system' || e.type === 'project' || e.type === 'tool'
    );
    if (internalEntities.length > 0 && backend === 'grok' && !reviewSignals.test(text)) {
      backend = 'claude';
      reasons.push(`internal entities (${internalEntities.map(e => e.id).join(', ')}) → claude`);
    }

    // General knowledge / research → Grok
    const knowledgeSignals = /what is\s+(a |the )?[A-Z]|who (is|was|invented|discovered)|when (did|was|is)|history of|explain\s+(how|what|why)|research|difference between|pros and cons|best practices|state of the art|latest|current|news|trend/i;
    if (knowledgeSignals.test(text) && !editSignals.test(text) && !fileSignals.test(text)) {
      backend = 'grok';
      reasons.push('general knowledge/research → grok');
    }

    // Quick factual lookups → Grok (faster, cheaper)
    const quickFactSignals = /^(what|who|when|where|how many|how much|how old|how long|how far|how tall|what year|which)\s+/i;
    if (quickFactSignals.test(text) && text.length < 100 && !editSignals.test(text) && !fileSignals.test(text) && internalEntities.length === 0) {
      backend = 'grok';
      reasons.push('short factual query → grok (faster)');
    }

    // ── Mythos signals — deep reasoning tier ──
    // Require at least 2 signal matches before recommending mythos (confidence threshold)
    let mythosSignalCount = 0;

    // Deep reasoning keywords
    const mythosDeepSignals = /\b(deep\s*(think|reason|analy)|continuity|identity\s*work|the\s*question|cross-project\s*synth|architectural\s*plan|belief\s*revis|novel\s*hypothes)/i;
    if (mythosDeepSignals.test(text)) {
      mythosSignalCount++;
      reasons.push('deep reasoning signal detected');
    }

    // Explicit mythos/strategic requests
    const mythosExplicitSignals = /\b(use\s*mythos|deep\s*mode|strategic\s*(think|mode)|mythos\s*mode)\b/i;
    if (mythosExplicitSignals.test(text)) {
      mythosSignalCount++;
      reasons.push('explicit mythos/strategic request');
    }

    // Additional contextual signals that reinforce mythos
    const mythosContextSignals = /\b(first\s*principles|paradigm\s*shift|fundamental|existential|philosophical|emergent|meta-cognit|self-model|world-model|long-term\s*strategy|belief\s*system|epistemic)/i;
    if (mythosContextSignals.test(text)) {
      mythosSignalCount++;
      reasons.push('strategic context signal detected');
    }

    // Only promote to mythos with 2+ signals (confidence threshold)
    if (mythosSignalCount >= 2) {
      backend = 'mythos';
      reasons.push(`mythos threshold met (${mythosSignalCount} signals) → strategic tier`);
    }

    // Collab signals → both models (highest priority)
    const collabSignals = /both perspectives|compare (answers|responses|models)|second opinion|what would (grok|claude) (say|think)|multiple (viewpoints|perspectives|angles)|collab|two (brains|minds|heads)|ask (both|grok and claude|claude and grok)/i;
    if (collabSignals.test(text)) {
      backend = 'collab';
      reasons.push('collaboration request → collab');
    }

    // Deep-collab signals → mythos + claude in parallel (strategic collaboration)
    const deepCollabSignals = /\b(deep.?collab|strategic\s*collab|mythos\s*collab|all\s*(three|3)\s*models?|full\s*synthesis)\b/i;
    if (deepCollabSignals.test(text)) {
      backend = 'deep-collab';
      reasons.push('deep collaboration request → mythos + claude in parallel (strategic tier)');
    }

    // Learner feedback: check past routing decisions
    if (this.engine.learner) {
      const similar = this.engine.learner.findSimilarDecisions(text, ['backend-routing'], 2);
      if (similar.length > 0) {
        const past = similar[0].decision;
        if (past.outcome?.success && past.chosen) {
          const pastBackend = past.chosen.replace('route-to-', '');
          if (['claude', 'grok', 'collab', 'mythos', 'deep-collab'].includes(pastBackend)) {
            reasons.push(`past similar routing to ${pastBackend} succeeded`);
          }
        }
      }
    }

    return {
      backend,
      costTier: COST_TIERS[backend] || (backend === 'collab' ? 'operational' : backend === 'deep-collab' ? 'strategic' : 'operational'),
      reasons,
      intent: intent.intent,
      confidence: intent.confidence
    };
  }

  // ── Route ──────────────────────────────────────────────────
  // The main entry point. Classify, assess, decide.

  route(input) {
    const t0 = Date.now();

    // 1. Classify intent
    const intent = this.classifyIntent(input);

    // 2. Extract entities
    const entities = this.extractEntities(input);

    // 3. Search knowledge graph
    const searchResults = this.engine.hybridSearch
      ? this.engine.hybridSearch(input, 5)
      : this.kg.findSimilar ? [] : [];

    // 4. Assess confidence
    const assessment = this.assessConfidence(intent, entities, searchResults);

    // 5. Backend recommendation (for when Soma escalates)
    const backendRec = assessment.recommendation !== 'soma'
      ? this.recommendBackend(intent, entities, input)
      : { backend: 'soma', reasons: ['handled by soma'], intent: intent.intent };

    // 6. Build routing decision
    const decision = {
      input,
      intent: intent.intent,
      intentConfidence: intent.confidence,
      entities,
      assessment,
      searchResults: searchResults.slice(0, 3).map(r => ({
        id: (r.node || r).id,
        title: (r.node || r).title,
        relevance: r.relevance || r.score || 0
      })),
      route: assessment.recommendation,
      recommendedBackend: backendRec.backend,
      backendReasons: backendRec.reasons,
      elapsed: Date.now() - t0
    };

    // 7. Log
    this.routingLog.push({
      timestamp: Date.now(),
      intent: intent.intent,
      route: decision.route,
      confidence: assessment.confidence,
      elapsed: decision.elapsed
    });
    if (this.routingLog.length > 200) this.routingLog.shift();

    // 8. Stats
    this.stats.totalRouted++;
    this.stats.byIntent[intent.intent] = (this.stats.byIntent[intent.intent] || 0) + 1;
    if (decision.route === 'soma') {
      this.stats.handledBySoma++;
    } else if (decision.route === 'claude') {
      this.stats.escalatedToClaude++;
    }
    if (decision.recommendedBackend && decision.recommendedBackend !== 'soma') {
      this.stats.byBackend = this.stats.byBackend || {};
      this.stats.byBackend[decision.recommendedBackend] = (this.stats.byBackend[decision.recommendedBackend] || 0) + 1;
    }

    return decision;
  }

  // ── Handle (when Soma can) ─────────────────────────────────
  // Actually produce a response from the graph + composer

  handle(routeDecision) {
    const { intent, entities, searchResults } = routeDecision;

    switch (intent) {
      case 'status-check':
        return this._handleStatusCheck();
      case 'self-query':
        return this._handleSelfQuery(routeDecision.input);
      case 'goal-query':
        return this._handleGoalQuery();
      case 'knowledge-query':
        return this._handleKnowledgeQuery(routeDecision.input, searchResults);
      case 'pattern-query':
        return this._handlePatternQuery();
      case 'insight-query':
        return this._handleInsightQuery();
      case 'learner-query':
        return this._handleLearnerQuery();
      case 'briefing-request':
        return this._handleBriefing();
      default:
        return {
          source: 'soma',
          confidence: routeDecision.assessment.confidence,
          response: this.engine.composer.answerFromKnowledge(routeDecision.input)
        };
    }
  }

  _handleStatusCheck() {
    const status = this.engine.status();
    const self = this.engine.self.currentState();
    const learner = this.engine.learner?.selfReport() || {};
    return {
      source: 'soma',
      confidence: 0.95,
      response: `I'm ${self.mood}. ${self.knowledge.nodes} nodes, ${self.knowledge.edges} edges in the graph. ` +
        `Confidence: ${(self.confidence * 100).toFixed(0)}%. ` +
        `${learner.activeLearnedRules || 0} learned rules active, ${learner.corrections || 0} corrections integrated. ` +
        (self.activeGaps.length > 0 ? `Known gaps: ${self.activeGaps.join('; ')}.` : 'No known gaps.')
    };
  }

  _handleSelfQuery(input) {
    const who = this.engine.whoAmI();
    const self = this.engine.self.currentState();
    const lower = (input || '').toLowerCase();

    if (lower.includes('what are you') || lower.includes('who are you') || lower.includes('describe yourself')) {
      return {
        source: 'soma',
        confidence: 0.9,
        response: `I'm ${who.identity}. ${who.nature}. I have ${self.knowledge.nodes} nodes of accumulated knowledge ` +
          `and ${this.engine.learner?.learnedRules.filter(r => !r.removed).length || 0} self-learned inference rules. ` +
          `My current state is ${self.mood} with ${(self.confidence * 100).toFixed(0)}% confidence. ` +
          `I run continuously via the Soma daemon — graph processing every 60 seconds, deep reflection every 5 minutes.`
      };
    }

    if (lower.includes('what can you do') || lower.includes('capabilities')) {
      return {
        source: 'soma',
        confidence: 0.9,
        response: `Without Claude: knowledge graph reasoning, pattern detection, rule-based inference, ` +
          `learning from corrections, hypothesis generation, self-assessment, and graph maintenance. ` +
          `With Claude as a tool: natural language generation, complex reasoning, code analysis, web search. ` +
          `I handle what I can and escalate what I can't.`
      };
    }

    return {
      source: 'soma',
      confidence: 0.7,
      response: this.engine.composer.answerFromKnowledge(input)
    };
  }

  _handleGoalQuery() {
    const goals = this.engine.goals.filter(g => g.status === 'active');
    if (goals.length === 0) {
      return { source: 'soma', confidence: 0.8, response: 'No active goals found.' };
    }
    const lines = goals.map(g => {
      const milestones = (g.milestones || []);
      const done = milestones.filter(m => m.done).length;
      return `- ${g.title} (${g.horizon || '?'} horizon, ${done}/${milestones.length} milestones)`;
    });
    return {
      source: 'soma',
      confidence: 0.9,
      response: `${goals.length} active goals:\n${lines.join('\n')}`
    };
  }

  _handleKnowledgeQuery(input, searchResults) {
    return {
      source: 'soma',
      confidence: searchResults?.length > 0 ? 0.6 : 0.3,
      response: this.engine.composer.answerFromKnowledge(input,
        searchResults?.map(r => r.node || r) || null)
    };
  }

  _handlePatternQuery() {
    const analysis = this.engine.patterns.analyze({ windowDays: 14 });
    const report = this.engine.composer.composePatternReport({ ...analysis, windowDays: 14 });
    return { source: 'soma', confidence: 0.85, response: report };
  }

  _handleInsightQuery() {
    const insights = this.engine.reasoner.generateInsights();
    if (insights.length === 0) {
      return { source: 'soma', confidence: 0.8, response: 'No insights at this time.' };
    }
    const lines = insights.slice(0, 5).map(i =>
      `[${i.priority}] ${i.type}: ${i.content}`
    );
    return {
      source: 'soma',
      confidence: 0.85,
      response: `${insights.length} insights:\n${lines.join('\n')}`
    };
  }

  _handleLearnerQuery() {
    const report = this.engine.learner?.selfReport();
    if (!report) return { source: 'soma', confidence: 0.5, response: 'Learner not available.' };
    return {
      source: 'soma',
      confidence: 0.9,
      response: `Learning engine: ${report.activeLearnedRules} active rules (${report.removedRules} removed), ` +
        `${report.corrections} corrections applied, ` +
        `${report.hypotheses.open} open hypotheses (${report.hypotheses.confirmed} confirmed, ${report.hypotheses.rejected} rejected), ` +
        `${report.decisions} decisions recorded (${report.decisionsWithOutcomes} with outcomes).`
    };
  }

  _handleBriefing() {
    if (!this.engine.briefing) return { source: 'soma', confidence: 0.5, response: 'Briefing system not available.' };
    return {
      source: 'soma',
      confidence: 0.95,
      response: this.engine.briefing.compose()
    };
  }

  // ── Self-Report ────────────────────────────────────────────

  selfReport() {
    const total = this.stats.totalRouted || 1;
    return {
      totalRouted: this.stats.totalRouted,
      handledBySoma: this.stats.handledBySoma,
      escalatedToClaude: this.stats.escalatedToClaude,
      somaRatio: (this.stats.handledBySoma / total * 100).toFixed(1) + '%',
      byIntent: this.stats.byIntent,
      byBackend: this.stats.byBackend || {},
      recentRoutes: this.routingLog.slice(-10)
    };
  }
}

// ── Intent Definitions ───────────────────────────────────────

Router.INTENTS = [
  {
    name: 'status-check',
    keywords: ['status', 'health', 'how are you', 'how\'s it going', 'uptime', 'running'],
    patterns: [/^(status|how are you|how's|what's your state)/i],
    startsWithAny: ['status', 'how are', 'how\'s'],
    handler: 'soma',
    keywordWeight: 0.3,
    patternWeight: 0.5
  },
  {
    name: 'self-query',
    keywords: ['what are you', 'who are you', 'describe yourself', 'capabilities', 'what can you do', 'soma', 'cortex core'],
    patterns: [/^(what|who) are you/i, /tell me about yourself/i, /what can you/i],
    isQuestion: true,
    handler: 'soma',
    keywordWeight: 0.35,
    patternWeight: 0.5
  },
  {
    name: 'goal-query',
    keywords: ['goals', 'objectives', 'purpose', 'mission', 'what are we working on', 'priorities'],
    patterns: [/^(what|show|list).*(goals|objectives|priorities)/i, /working (on|toward)/i],
    isQuestion: true,
    handler: 'soma',
    keywordWeight: 0.3,
    patternWeight: 0.5
  },
  {
    name: 'knowledge-query',
    keywords: ['what is', 'what do you know about', 'tell me about', 'explain', 'knowledge'],
    patterns: [/^(what is|what do you know|tell me about|explain)\s/i, /^(what|how|why)\s.*\?$/i],
    isQuestion: true,
    handler: 'soma',
    keywordWeight: 0.2,
    patternWeight: 0.4
  },
  {
    name: 'pattern-query',
    keywords: ['patterns', 'trends', 'recurring', 'frequency', 'anomalies'],
    patterns: [/^(show|find|analyze|what).*(patterns|trends)/i],
    handler: 'soma',
    keywordWeight: 0.35,
    patternWeight: 0.5
  },
  {
    name: 'insight-query',
    keywords: ['insights', 'contradictions', 'connections', 'discoveries'],
    patterns: [/^(show|generate|find|what).*(insights|contradictions)/i],
    handler: 'soma',
    keywordWeight: 0.35,
    patternWeight: 0.5
  },
  {
    name: 'learner-query',
    keywords: ['learning', 'learned rules', 'hypotheses', 'corrections', 'decisions', 'learner'],
    patterns: [/^(what|how|show).*(learn|hypothes|correction)/i],
    handler: 'soma',
    keywordWeight: 0.35,
    patternWeight: 0.5
  },
  {
    name: 'creative-request',
    keywords: ['build', 'create', 'design', 'write', 'generate', 'make me', 'implement'],
    patterns: [/^(build|create|design|write|make|implement)\s/i],
    startsWithAny: ['build', 'create', 'design', 'write', 'make', 'implement'],
    handler: 'claude',
    keywordWeight: 0.3,
    patternWeight: 0.5
  },
  {
    name: 'code-request',
    keywords: ['code', 'function', 'class', 'bug', 'error', 'refactor', 'test', 'fix the'],
    patterns: [/^(fix|debug|refactor|add|update|modify)\s/i, /\.(js|ts|py|css|html)\b/],
    handler: 'claude',
    keywordWeight: 0.3,
    patternWeight: 0.5
  },
  {
    name: 'debug-request',
    keywords: ['debug', 'error', 'crash', 'broken', 'not working', 'fails', 'stack trace'],
    patterns: [/^(debug|why is|why does|it('s| is) (broken|crashing|failing))/i],
    handler: 'claude',
    keywordWeight: 0.35,
    patternWeight: 0.5
  },
  {
    name: 'conversation',
    keywords: ['think about', 'opinion', 'what do you think', 'discuss', 'thoughts on', 'feel about'],
    patterns: [/what do you think/i, /your (opinion|thoughts|take)/i, /how do you feel/i],
    isQuestion: true,
    handler: 'claude',
    keywordWeight: 0.25,
    patternWeight: 0.45
  },
  {
    name: 'briefing-request',
    keywords: ['briefing', 'catch me up', 'what did i miss', 'what happened', 'bring me up to speed', 'what\'s new', 'update me'],
    patterns: [/^(briefing|catch me up|what did i miss|what happened|what's new)/i, /bring me up to speed/i, /^update me/i, /^soma briefing/i],
    startsWithAny: ['briefing', 'catch me up', 'what did i miss', 'soma briefing', 'update me'],
    handler: 'soma',
    keywordWeight: 0.4,
    patternWeight: 0.6
  }
];

module.exports = Router;
