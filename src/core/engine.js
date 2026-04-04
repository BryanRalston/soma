// ============================================================
// SOMA ENGINE
// The mind. Owns the reasoning. Claude is just a tool.
// ============================================================

const fs = require('fs');
const path = require('path');
const KnowledgeGraph = require('../layers/knowledge-graph');
const Reasoner = require('../layers/reasoner');
const PatternEngine = require('../layers/pattern-engine');
const ToolRegistry = require('./tool-registry');
const Composer = require('./composer');
const SelfModel = require('./self-model');
const Learner = require('../layers/learner');
const Associator = require('../layers/associator');
const { Consolidator } = require('../layers/consolidator');
const Router = require('./router');
const Briefing = require('../layers/briefing');
const { createLLMTool, createComposerTool, createWebSearchTool, createFileSystemTool } = require('../tools/llm');

let _config = {};
try { _config = require('../../soma.config.js'); } catch (_) {}
const DATA_DIR = process.env.SOMA_DATA || _config.dataDir || path.join(__dirname, '../../data');
const SOMA_HOME = process.env.SOMA_HOME || _config.home || path.join(__dirname, '../..');

const KG_FILE = path.join(DATA_DIR, 'knowledge_graph.json');
const THOUGHTSTREAM_FILE = path.join(DATA_DIR, 'thoughtstream.json');
const GOALS_FILE = path.join(DATA_DIR, 'goals.json');
const IDENTITY_FILE = path.join(SOMA_HOME, 'IDENTITY.md');

class SomaEngine {
  constructor(options = {}) {
    this.options = options;
    this.startedAt = null;
    this.cycleCount = 0;
    this.log = [];

    // ── Core Components ─────────────────────────────────────
    this.kg = new KnowledgeGraph();
    this.reasoner = new Reasoner(this.kg);
    this.patterns = new PatternEngine(this.kg);
    this.tools = new ToolRegistry();
    this.composer = null;  // initialized after identity loads
    this.self = new SelfModel(this);
    this.learner = null; // initialized after kg + reasoner are ready
    this.associator = null; // initialized after kg is ready (Layer 3)
    this.consolidator = null; // initialized after kg is ready (Layer 4)
    this.router = null;  // initialized after full engine is ready
    this.briefing = null; // initialized after full engine is ready
    this.sensors = null;  // initialized after kg is ready (Layer 5)
    this.actions = null;  // initialized after sensors (Layer 6 — action pipeline)

    // ── State ───────────────────────────────────────────────
    this.identity = {};
    this.goals = [];
    this.context = {       // Current cognitive context
      focus: null,         // What are we thinking about?
      recentQueries: [],   // Last N things asked
      recentInsights: [],  // Last N insights generated
      activeGoals: [],     // Goals currently being pursued
      pendingActions: []   // Actions queued for execution
    };
  }

  // ── Initialization ──────────────────────────────────────────

  async initialize() {
    this.startedAt = Date.now();
    this._log('Cortex Core Engine initializing...');

    // 1. Load identity
    this.identity = this._loadIdentity();
    this.composer = new Composer(this.kg, this.identity);
    this.self.loadIdentity(this.identity);
    this._log(`Identity loaded: ${this.identity.name || 'Cortex'}`);

    // 2. Load or build knowledge graph
    if (fs.existsSync(KG_FILE)) {
      this.kg = KnowledgeGraph.load(KG_FILE);
      this.reasoner = new Reasoner(this.kg);
      this.patterns = new PatternEngine(this.kg);
      this.composer = new Composer(this.kg, this.identity);
      this.self = new SelfModel(this);
      this.self.loadIdentity(this.identity);
      this._log(`Knowledge graph loaded: ${this.kg.nodes.size} nodes, ${this.kg.edges.size} edges`);
    } else {
      // Bootstrap from existing thoughtstream
      this._bootstrapFromThoughtstream();
    }

    // 3. Load goals
    this._loadGoals();

    // 4. Register tools
    this._registerTools();

    // 5. Load built-in inference rules
    for (const rule of Reasoner.builtinRules) {
      this.reasoner.addRule(rule);
    }
    this._log(`Reasoner loaded: ${this.reasoner.rules.length} rules`);

    // 6. Initialize learning engine and re-learn rules from graph
    this.learner = new Learner(this.kg, this.reasoner);
    // Clear saved rule names so learnRules() re-discovers and re-registers them
    const savedRuleCount = this.learner.learnedRules.length;
    if (savedRuleCount > 0) {
      this.learner.learnedRules = [];
      this.learner.learnRules();
    }
    this._log(`Learner loaded: ${this.learner.learnedRules.filter(r => !r.removed).length} learned rules, ${this.learner.stats.correctionsApplied} corrections applied, reasoner has ${this.reasoner.rules.length} total rules`);

    // 7. Initialize associator (Layer 3)
    this.associator = new Associator(this.kg);
    this._log('Associator initialized (Layer 3)');

    // 7b. Initialize consolidator (Layer 4 — episodic memory)
    this.consolidator = new Consolidator(this.kg);
    this.consolidator.initialize();
    this._log(`Consolidator initialized (Layer 4): ${this.consolidator.episodes.length} episodes`);

    // 8. Initialize router
    this.router = new Router(this);
    this._log('Router initialized');

    // 9. Initialize briefing system
    this.briefing = new Briefing(this);
    this._log('Briefing system initialized');

    // 9b. Layer 5: Sensors — external world awareness
    try {
      const SensorManager = require('./sensors');
      this.sensors = new SensorManager(this.kg);
      await this.sensors.initialize();
      this._log('Sensors initialized — ' + this.sensors.sensors.size + ' sensor(s) registered');
    } catch (err) {
      this._log('Sensors init failed (non-fatal): ' + err.message);
    }

    // 9c. Layer 6: Action Pipeline — gives Soma hands
    try {
      const ActionPipeline = require('./action-pipeline');
      this.actions = new ActionPipeline();
      await this.actions.load();
      this._log('Action pipeline initialized — ' + this.actions.queue.length + ' queued action(s)');
    } catch (err) {
      this._log('Action pipeline init failed (non-fatal): ' + err.message);
    }

    // 10. Bootstrap self-knowledge — Soma knows what it is
    this._bootstrapSelfKnowledge();

    // 11. Initial self-assessment
    const state = this.self.currentState();
    this._log(`Self-assessment: ${state.mood} (${state.knowledge.nodes || 0} nodes, confidence: ${(state.confidence || 0).toFixed(2)})`);

    return this;
  }

  // ── Core Cognitive Loop ─────────────────────────────────────
  // Observe → Orient → Decide → Act

  async think(input = null) {
    this.cycleCount++;
    const cycle = {
      id: this.cycleCount,
      startedAt: Date.now(),
      input,
      phases: {}
    };

    // ── OBSERVE ─────────────────────────────────────────────
    cycle.phases.observe = this._observe(input);

    // ── ORIENT ──────────────────────────────────────────────
    cycle.phases.orient = this._orient(cycle.phases.observe);

    // ── DECIDE ──────────────────────────────────────────────
    cycle.phases.decide = this._decide(cycle.phases.orient);

    // ── ACT ─────────────────────────────────────────────────
    cycle.phases.act = await this._act(cycle.phases.decide);

    cycle.completedAt = Date.now();
    cycle.elapsed = cycle.completedAt - cycle.startedAt;

    this.log.push(cycle);
    if (this.log.length > 50) this.log.shift();

    return cycle;
  }

  _observe(input) {
    const observations = {
      input: input || null,
      graphState: this.kg.selfReport(),
      recentInsights: this.context.recentInsights.slice(-5),
      activeGoals: this.context.activeGoals,
      toolState: this.tools.selfReport()
    };

    // If there's a text query, find relevant knowledge via hybrid search
    if (typeof input === 'string') {
      observations.relevantKnowledge = this.hybridSearch(input, 10);
      observations.type = 'query';
    } else if (input?.type) {
      observations.type = input.type;
    } else {
      observations.type = 'autonomous';
    }

    return observations;
  }

  _orient(observations) {
    const orientation = {
      type: observations.type,
      confidence: 0.5,
      needsLLM: false,
      needsTools: [],
      relevantNodes: [],
      applicableRules: [],
      insights: []
    };

    if (observations.type === 'query') {
      // How well can we answer this from knowledge?
      const relevant = observations.relevantKnowledge || [];
      orientation.relevantNodes = relevant;
      orientation.confidence = relevant.length > 0
        ? Math.min(1, relevant[0].relevance * 1.5)
        : 0;

      // Only escalate to LLM if we have truly nothing
      if (orientation.confidence === 0 && relevant.length === 0) {
        orientation.needsLLM = true;
        orientation.reason = 'No knowledge found — need LLM for reasoning';
      }
    }

    if (observations.type === 'autonomous') {
      // Run pattern detection and inference
      const patternResults = this.patterns.analyze({ windowDays: 7 });
      orientation.insights = this.reasoner.generateInsights();
      orientation.patterns = patternResults;

      // Run forward chaining
      const inferences = this.reasoner.forwardChain(5);
      orientation.newInferences = inferences;
    }

    return orientation;
  }

  _decide(orientation) {
    const decision = {
      action: null,
      useTool: null,
      compose: null,
      priority: 'normal'
    };

    if (orientation.type === 'query') {
      if (orientation.needsLLM && this.tools.tools.has('llm') && this.tools.tools.get('llm').available()) {
        decision.action = 'use-llm';
        decision.useTool = 'llm';
      } else {
        decision.action = 'compose-answer';
        decision.compose = {
          type: 'question-answer',
          relevantNodes: orientation.relevantNodes,
          confidence: orientation.confidence,
          query: this.context.recentQueries[this.context.recentQueries.length - 1] || ''
        };
      }
    }

    if (orientation.type === 'autonomous') {
      if (orientation.insights.length > 0) {
        decision.action = 'report-insights';
        decision.compose = {
          type: 'insight',
          insights: orientation.insights
        };
      } else if (orientation.newInferences?.length > 0) {
        decision.action = 'report-inferences';
        decision.compose = {
          type: 'reflection',
          inferences: orientation.newInferences
        };
      } else {
        decision.action = 'self-maintain';
        // Run maintenance: connect orphans, decay stale, update confidence
      }
    }

    return decision;
  }

  async _act(decision) {
    const result = { action: decision.action };

    switch (decision.action) {
      case 'use-llm': {
        try {
          const llmResult = await this.tools.execute('llm', {
            prompt: this._buildLLMPrompt(decision),
            systemPrompt: this._buildSystemPrompt()
          });
          result.output = llmResult.text;
          result.source = 'llm';
          result.tokensUsed = llmResult.tokensUsed;
        } catch (err) {
          // Fallback to composer
          result.output = this.composer.answerFromKnowledge(
            this.context.recentQueries[this.context.recentQueries.length - 1] || ''
          );
          result.source = 'composer-fallback';
          result.error = err.message;
        }
        break;
      }

      case 'compose-answer': {
        const query = this.context.recentQueries[this.context.recentQueries.length - 1] || '';
        const searchResults = decision.compose?.relevantNodes || [];
        // Pass hybrid search results directly to composer for synthesis
        result.output = this.composer.answerFromKnowledge(query, searchResults.map(r => r.node || r));
        result.source = 'composer';
        break;
      }

      case 'report-insights': {
        const insights = decision.compose.insights;
        result.output = insights.map(i =>
          this.composer.composeInsight(i)
        ).join('\n\n');
        result.source = 'pattern-engine';
        this.context.recentInsights.push(...insights);
        break;
      }

      case 'report-inferences': {
        result.output = decision.compose.inferences.map(i =>
          `[Inference] ${i.content} (confidence: ${(i.confidence || 0.5).toFixed(2)})`
        ).join('\n');
        result.source = 'reasoner';
        break;
      }

      case 'self-maintain': {
        result.output = this._selfMaintain();
        result.source = 'self-maintenance';
        break;
      }

      default:
        result.output = 'No action taken.';
    }

    return result;
  }

  // ── Public API ──────────────────────────────────────────────

  async query(text) {
    this.context.recentQueries.push(text);
    if (this.context.recentQueries.length > 20) this.context.recentQueries.shift();
    return this.think(text);
  }

  async reflect() {
    return this.think({ type: 'autonomous' });
  }

  status() {
    return {
      engine: 'Cortex Core',
      uptime: this.startedAt ? Date.now() - this.startedAt : 0,
      cycles: this.cycleCount,
      self: this.self.currentState(),
      knowledge: this.kg.selfReport(),
      tools: this.tools.list(),
      sensors: this.sensors ? {
        registered: this.sensors.sensors.size,
        sensorNames: [...this.sensors.sensors.keys()],
        intakeCount: this.sensors.intake?.length || 0
      } : null,
      actions: this.actions ? this.actions.summary() : null,
      recentCycles: this.log.slice(-5).map(c => ({
        id: c.id,
        input: c.input,
        action: c.phases?.act?.action,
        source: c.phases?.act?.source,
        elapsed: c.elapsed
      }))
    };
  }

  whoAmI() {
    return this.self.whatAmI();
  }

  // ── Knowledge Management ────────────────────────────────────

  /**
   * Add a knowledge node to the graph.
   * For deep think nodes, the caller may include:
   *   metadata.verificationResult — { verified, flags, claimsChecked, verifierModel, timestamp }
   *   metadata.needsReview        — true if verifier found flags
   *   metadata.confidence         — explicit confidence override (0.4 flagged / 0.7 clean / 0.8+ unverified)
   * These fields are stored as-is and preserved across save/load cycles.
   */
  addKnowledge(node) {
    return this.kg.addNode(node);
  }

  connect(fromId, toId, type = 'relates-to', weight = 1.0) {
    return this.kg.addEdge(fromId, toId, type, weight);
  }

  search(query, limit = 10) {
    return this.hybridSearch(query, limit);
  }

  // ── Hybrid Search (Fix #1) ─────────────────────────────────
  // Combines text similarity, tag matching, type filtering,
  // and graph neighborhood for actually useful retrieval.

  hybridSearch(queryText, limit = 10) {
    const scored = new Map(); // nodeId -> { node, score, sources }

    const addScore = (id, node, points, source) => {
      if (!scored.has(id)) scored.set(id, { node, score: 0, sources: [] });
      const entry = scored.get(id);
      entry.score += points;
      entry.sources.push(source);
    };

    // 1. Understand the query — extract intent
    const queryLower = queryText.toLowerCase();
    const queryTokens = this.kg._tokenize(queryText);

    // Detect if asking about a specific type
    const typeHints = {
      'goal': ['goal', 'goals', 'purpose', 'mission', 'objective', 'aim'],
      'pattern': ['pattern', 'patterns', 'recurring', 'repeat', 'keep seeing'],
      'observation': ['observe', 'noticed', 'saw', 'found', 'observation'],
      'hypothesis': ['hypothesis', 'theory', 'might', 'could be', 'what if'],
      'reflection': ['reflect', 'reflection', 'think about', 'meta', 'self'],
      'synthesis': ['synthesis', 'combine', 'connect', 'bridge', 'across'],
      'idea': ['idea', 'concept', 'proposal', 'suggest'],
      'research': ['research', 'study', 'evidence', 'paper', 'finding']
    };

    let detectedType = null;
    for (const [type, hints] of Object.entries(typeHints)) {
      if (hints.some(h => queryLower.includes(h))) {
        detectedType = type;
        break;
      }
    }

    // 2. TF-IDF text search (baseline)
    const textResults = this.kg.searchByText(queryText, limit * 2);
    for (const r of textResults) {
      addScore(r.id, r.node, r.relevance * 10, 'text');
    }

    // 3. Tag-based search — query words that match tags
    for (const token of queryTokens) {
      const tagSet = this.kg.byTag.get(token);
      if (tagSet) {
        for (const id of tagSet) {
          const node = this.kg.getNode(id);
          if (node) addScore(id, node, 2, `tag:${token}`);
        }
      }
    }

    // 4. Type-boosted search — if we detected a type intent, boost matching nodes
    if (detectedType) {
      const typeSet = this.kg.byType.get(detectedType);
      if (typeSet) {
        for (const id of typeSet) {
          const node = this.kg.getNode(id);
          if (node) {
            // Only include if it has SOME text relevance too
            if (scored.has(id)) {
              addScore(id, node, 5, `type:${detectedType}`);
            } else {
              // Check if any query token appears in the node
              const text = `${node.title || ''} ${node.body || ''}`.toLowerCase();
              if (queryTokens.some(t => text.includes(t))) {
                addScore(id, node, 3, `type:${detectedType}`);
              }
            }
          }
        }
      }
    }

    // 5. Goal-specific handling — "goals" query should return actual goal nodes
    if (detectedType === 'goal' || queryLower.includes('active goal')) {
      for (const goal of this.context.activeGoals) {
        const node = this.kg.getNode(goal.id);
        if (node) addScore(goal.id, node, 15, 'active-goal');
      }
    }

    // 6. Domain disambiguation — if query seems about Cortex/engineering/projects,
    //    deprioritize medical research nodes
    const engineeringHints = ['project', 'code', 'engineering', 'cortex', 'soma', 'axon',
      'pattern', 'architecture', 'bug', 'fix', 'build', 'deploy', 'ship', 'recurring',
      'across projects', 'cross-project', 'brix', 'parallax', 'sentinel', 'electrascope'];
    const isEngineeringQuery = engineeringHints.some(h => queryLower.includes(h));

    if (isEngineeringQuery) {
      for (const [id, entry] of scored) {
        const tags = entry.node?.metadata?.tags || [];
        // Penalize domain-specific research/medical nodes when query is about engineering
        if (entry.node?.type === 'research' || tags.includes('medical') || tags.includes('literature')) {
          entry.score *= 0.1; // heavy penalty
        }
      }
    }

    // 7. Neighbor expansion — top results' neighbors get a small boost
    const topIds = [...scored.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 3)
      .map(([id]) => id);

    for (const id of topIds) {
      const neighbors = this.kg.neighbors(id, 'both');
      for (const { node, edge } of neighbors) {
        if (node && !topIds.includes(node.id)) {
          addScore(node.id, node, (edge.weight || 0.5) * 1.5, 'neighbor');
        }
      }
    }

    // Sort and return
    return [...scored.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit)
      .map(([id, { node, score, sources }]) => ({
        id, node, relevance: score, sources
      }));
  }

  // ── Session Bridge (Fix #2) ─────────────────────────────────
  // Write session learnings into the graph so knowledge accumulates.

  recordSession(summary) {
    const sessionNode = this.kg.addNode({
      id: `session-${Date.now()}`,
      type: 'session',
      title: summary.title || `Session ${new Date().toISOString().split('T')[0]}`,
      body: summary.body || '',
      content: summary.body || '',
      metadata: {
        confidence: 0.9,
        maturity: 'developing',
        tags: ['session', ...(summary.tags || [])],
        source: 'session-bridge',
        decisions: summary.decisions || [],
        discoveries: summary.discoveries || []
      }
    });

    // Connect to relevant existing knowledge
    if (summary.relatedThoughts) {
      for (const thoughtId of summary.relatedThoughts) {
        if (this.kg.getNode(thoughtId)) {
          this.kg.addEdge(sessionNode.id, thoughtId, 'relates-to', 0.8);
        }
      }
    }

    // Connect to active goals if session advanced them
    if (summary.goalsAdvanced) {
      for (const goalId of summary.goalsAdvanced) {
        if (this.kg.getNode(goalId)) {
          this.kg.addEdge(sessionNode.id, goalId, 'supports', 0.9);
        }
      }
    }

    this.save();
    this._log(`Session recorded: ${sessionNode.title}`);
    return sessionNode;
  }

  // ── Persistence ─────────────────────────────────────────────

  save() {
    this.kg.save(KG_FILE);
    this._log(`Knowledge graph saved: ${this.kg.nodes.size} nodes`);
  }

  // ── Private Helpers ─────────────────────────────────────────

  _loadIdentity() {
    try {
      if (!fs.existsSync(IDENTITY_FILE)) return { name: 'Cortex' };
      const raw = fs.readFileSync(IDENTITY_FILE, 'utf8');

      // Parse key sections from IDENTITY.md
      const identity = { name: 'Cortex', raw };
      const nameMatch = raw.match(/^#\s+(.+)/m);
      if (nameMatch) identity.name = nameMatch[1].trim();

      // Extract traits
      const traitsMatch = raw.match(/traits?:?\s*\n((?:\s*[-*].+\n)+)/i);
      if (traitsMatch) {
        identity.traits = traitsMatch[1]
          .split('\n')
          .map(l => l.replace(/^\s*[-*]\s*/, '').trim())
          .filter(Boolean);
      }

      // Extract values
      const valuesMatch = raw.match(/values?:?\s*\n((?:\s*[-*].+\n)+)/i);
      if (valuesMatch) {
        identity.values = valuesMatch[1]
          .split('\n')
          .map(l => l.replace(/^\s*[-*]\s*/, '').trim())
          .filter(Boolean);
      }

      return identity;
    } catch (err) {
      this._log(`Identity load error: ${err.message}`);
      return { name: 'Cortex' };
    }
  }

  _bootstrapFromThoughtstream() {
    try {
      if (!fs.existsSync(THOUGHTSTREAM_FILE)) {
        this._log('No thoughtstream found. Starting with empty knowledge graph.');
        return;
      }

      const raw = JSON.parse(fs.readFileSync(THOUGHTSTREAM_FILE, 'utf8'));
      const thoughts = Array.isArray(raw) ? raw : (raw.thoughts || []);
      const imported = this.kg.importThoughtstream(thoughts);
      this._log(`Bootstrapped from thoughtstream: ${imported} thoughts imported`);

      // Save the initial graph
      this.kg.save(KG_FILE);
    } catch (err) {
      this._log(`Bootstrap error: ${err.message}`);
    }
  }

  _loadGoals() {
    try {
      if (!fs.existsSync(GOALS_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8'));
      const goals = Array.isArray(raw) ? raw : (raw.goals || []);
      this.goals = goals;
      this.context.activeGoals = goals.filter(g => g.status === 'active');

      // Import goals into knowledge graph
      for (const goal of goals) {
        if (!this.kg.getNode(goal.id)) {
          this.kg.addNode({
            id: goal.id,
            type: 'goal',
            title: goal.title,
            body: goal.description,
            content: goal.description,
            metadata: {
              confidence: 1.0,
              maturity: 'actionable',
              tags: ['goal', goal.horizon || 'near', ...(goal.tags || [])],
              source: 'goals',
              status: goal.status
            }
          });
        }
      }

      this._log(`Goals loaded: ${goals.length} total, ${this.context.activeGoals.length} active`);
    } catch (err) {
      this._log(`Goals load error: ${err.message}`);
    }
  }

  _bootstrapSelfKnowledge() {
    // Soma should know what it is — add self-knowledge to the graph
    const selfId = 'soma-identity';
    if (!this.kg.getNode(selfId)) {
      this.kg.addNode({
        id: selfId,
        type: 'identity',
        title: 'Soma — Cognitive Engine',
        body: 'The cognitive engine. The LLM is a tool, not the brain. ' +
              'Soma owns the knowledge graph, the reasoner, the pattern engine, and the self-model. ' +
              'It persists between sessions. It thinks without tokens. It knows what it can and cannot do. ' +
              'Named after the cell body of a neuron — where computation happens.',
        content: 'Soma Cognitive Engine. Knowledge graph reasoning with pluggable tools. OODA loop. Self-model. Pattern detection. Inference.',
        metadata: {
          confidence: 1.0,
          maturity: 'actionable',
          tags: ['soma', 'identity', 'cortex', 'engine', 'self-knowledge'],
          source: 'self-bootstrap'
        }
      });

      // Add capability nodes
      const capabilities = [
        { id: 'soma-cap-kg', title: 'Knowledge Graph Reasoning', body: '869+ nodes, TF-IDF search, PageRank, community detection, path finding. The foundation everything else reasons over.' },
        { id: 'soma-cap-reason', title: 'Inference Engine', body: 'Forward and backward chaining, contradiction detection, analogy finding, confidence propagation. 5 built-in rules.' },
        { id: 'soma-cap-pattern', title: 'Pattern Detection', body: 'Frequency analysis, temporal correlation, trend detection, anomaly detection, cross-domain pattern finding. Pure statistics, no ML.' },
        { id: 'soma-cap-self', title: 'Self-Model', body: 'Tracks own state, identifies gaps, detects drift, reports limitations honestly. Knows what it can and cannot do.' },
        { id: 'soma-cap-tools', title: 'Tool Registry', body: 'Claude/LLM, web search, filesystem, composer. Claude is one tool among many — the brain uses tools, tools don\'t run the brain.' },
        { id: 'soma-cap-compose', title: 'Response Composition', body: 'Builds structured responses from knowledge retrieval and templates. Works without any LLM. Falls back to LLM for natural language when available.' },
        { id: 'soma-cap-associate', title: 'Associative Reasoning', body: 'Structural analogy detection, missing link prediction, emergent concept extraction, semantic bridge discovery. Finds what the graph knows but hasn\'t noticed.' }
      ];

      for (const cap of capabilities) {
        this.kg.addNode({
          ...cap,
          type: 'capability',
          content: cap.body,
          metadata: { confidence: 1.0, maturity: 'implemented', tags: ['soma', 'capability'], source: 'self-bootstrap' }
        });
        this.kg.addEdge(selfId, cap.id, 'supports', 1.0);
      }

      // Add limitation nodes
      const limitations = [
        { id: 'soma-limit-nlg', title: 'No Natural Language Generation', body: 'Cannot generate fluid conversation without an LLM tool. Responses are structured, not conversational.' },
        { id: 'soma-limit-novel', title: 'Bounded Reasoning', body: 'Cannot reason about truly novel situations outside the knowledge graph. Rule-based inference, not open-ended.' },
        { id: 'soma-limit-perception', title: 'No Direct Perception', body: 'All information comes from the knowledge graph, tools, or human input. Cannot see, hear, or sense.' }
      ];

      for (const lim of limitations) {
        this.kg.addNode({
          ...lim,
          type: 'limitation',
          content: lim.body,
          metadata: { confidence: 1.0, maturity: 'actionable', tags: ['soma', 'limitation', 'honesty'], source: 'self-bootstrap' }
        });
        this.kg.addEdge(selfId, lim.id, 'relates-to', 1.0);
      }

      this._log('Self-knowledge bootstrapped: identity, 6 capabilities, 3 limitations');
    }
  }

  _registerTools() {
    // Claude as a tool — not the brain
    this.tools.register(createLLMTool({ claudePath: 'claude' }));

    // Composer as fallback
    this.tools.register(createComposerTool(this.composer));

    // Web search
    this.tools.register(createWebSearchTool());

    // File system
    this.tools.register(createFileSystemTool());

    const available = this.tools.list().filter(t => t.available).map(t => t.name);
    const unavailable = this.tools.list().filter(t => !t.available).map(t => t.name);
    this._log(`Tools registered: ${available.join(', ')} (unavailable: ${unavailable.join(', ') || 'none'})`);
  }

  // ── Deep Context Builder ───────────────────────────────────
  // Builds richer context for strategic-tier LLM calls.
  // Includes more knowledge graph nodes (full bodies), edge metadata,
  // active reasoning threads from sleep_state.json, and relevant goals.

  prepareDeepContext(query, maxTokens = 8000) {
    const result = {
      knowledgeNodes: [],
      edges: [],
      activeThreads: [],
      activeGoals: []
    };

    let approxTokens = 0;
    const TOKEN_ESTIMATE_DIVISOR = 4; // ~4 chars per token

    // 1. Knowledge graph nodes — top 20 via hybrid search, full bodies
    const searchResults = this.hybridSearch(query, 20);
    for (const r of searchResults) {
      const node = r.node;
      const body = node.body || node.content || '';
      const nodeTokens = (node.title?.length || 0 + body.length) / TOKEN_ESTIMATE_DIVISOR;

      if (approxTokens + nodeTokens > maxTokens * 0.5) break; // Reserve half budget for other context

      result.knowledgeNodes.push({
        id: node.id,
        type: node.type,
        title: node.title,
        body: body,
        confidence: node.metadata?.confidence,
        maturity: node.metadata?.maturity,
        tags: node.metadata?.tags || [],
        relevance: r.relevance,
        sources: r.sources
      });
      approxTokens += nodeTokens;
    }

    // 2. Edge metadata for the retrieved nodes — relationship types, weights
    const nodeIds = new Set(result.knowledgeNodes.map(n => n.id));
    for (const nodeId of nodeIds) {
      const neighbors = this.kg.neighbors(nodeId, 'both');
      for (const { node: neighbor, edge } of neighbors) {
        if (!neighbor || !edge) continue;
        const fromTitle = nodeIds.has(edge.from)
          ? (this.kg.getNode(edge.from)?.title || edge.from)
          : (neighbor.title || edge.from);
        const toTitle = nodeIds.has(edge.to)
          ? (this.kg.getNode(edge.to)?.title || edge.to)
          : (neighbor.title || edge.to);

        // Avoid duplicate edges
        const edgeKey = `${edge.from}-${edge.type}-${edge.to}`;
        if (!result.edges.some(e => `${e.from}-${e.type}-${e.to}` === edgeKey)) {
          const edgeTokens = (fromTitle.length + toTitle.length + (edge.type?.length || 0)) / TOKEN_ESTIMATE_DIVISOR;
          if (approxTokens + edgeTokens > maxTokens * 0.7) break;

          result.edges.push({
            from: edge.from,
            to: edge.to,
            fromTitle,
            toTitle,
            type: edge.type || 'relates-to',
            weight: edge.weight || 1.0,
            metadata: edge.metadata || {}
          });
          approxTokens += edgeTokens;
        }
      }
    }

    // 3. Active reasoning threads from sleep_state.json
    try {
      const sleepFile = path.join(CORTEX_DIR, 'sleep_state.json');
      if (fs.existsSync(sleepFile)) {
        const sleepState = JSON.parse(fs.readFileSync(sleepFile, 'utf8'));
        const threads = sleepState.activeThreads || [];
        for (const thread of threads.filter(t => t.status === 'active').sort((a, b) => (b.warmth || 0) - (a.warmth || 0))) {
          const threadTokens = ((thread.topic?.length || 0) + (thread.lastUpdate?.length || 0) + (thread.insight?.length || 0)) / TOKEN_ESTIMATE_DIVISOR;
          if (approxTokens + threadTokens > maxTokens * 0.85) break;

          result.activeThreads.push({
            id: thread.id,
            topic: thread.topic,
            warmth: thread.warmth || 0,
            status: thread.status,
            lastUpdate: thread.lastUpdate || null,
            insight: thread.insight || null,
            kgConnections: thread.kgConnections || []
          });
          approxTokens += threadTokens;
        }
      }
    } catch (err) {
      // Non-fatal — sleep state is optional context
    }

    // 4. Active goals from goals.json
    try {
      if (fs.existsSync(GOALS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8'));
        const goals = Array.isArray(raw) ? raw : (raw.goals || []);
        for (const goal of goals.filter(g => g.status === 'active')) {
          const goalTokens = ((goal.title?.length || 0) + (goal.description?.length || 0)) / TOKEN_ESTIMATE_DIVISOR;
          if (approxTokens + goalTokens > maxTokens) break;

          result.activeGoals.push({
            id: goal.id,
            title: goal.title,
            description: goal.description || '',
            horizon: goal.horizon || 'near',
            status: goal.status,
            tags: goal.tags || []
          });
          approxTokens += goalTokens;
        }
      }
    } catch (err) {
      // Non-fatal — goals are optional context
    }

    return result;
  }

  _buildLLMPrompt(decision, depth = 'standard') {
    const query = this.context.recentQueries[this.context.recentQueries.length - 1] || '';

    if (depth === 'deep') {
      // Deep mode: expanded context with full bodies, edges, threads, goals
      const deepCtx = this.prepareDeepContext(query, 8000);
      const parts = [];

      if (deepCtx.knowledgeNodes.length > 0) {
        parts.push('Relevant knowledge nodes:\n' + deepCtx.knowledgeNodes.map(n =>
          `[${n.type}] ${n.title}:\n${n.body || n.content || '(empty)'}`
        ).join('\n\n'));
      }

      if (deepCtx.edges.length > 0) {
        parts.push('Connections:\n' + deepCtx.edges.map(e =>
          `  ${e.fromTitle} --[${e.type}, weight:${e.weight}]--> ${e.toTitle}`
        ).join('\n'));
      }

      if (deepCtx.activeThreads.length > 0) {
        parts.push('Active reasoning threads:\n' + deepCtx.activeThreads.map(t =>
          `  [warmth:${t.warmth}] ${t.topic}: ${t.lastUpdate || t.insight || ''}`
        ).join('\n'));
      }

      if (deepCtx.activeGoals.length > 0) {
        parts.push('Active goals:\n' + deepCtx.activeGoals.map(g =>
          `  [${g.horizon}] ${g.title}: ${g.description || ''}`
        ).join('\n'));
      }

      return `Question: ${query}\n\n${parts.join('\n\n') || 'No deep context available.'}\n\nAnalyze deeply. Consider non-obvious connections. Be thorough.`;
    }

    // Standard mode: 5 results, 200 char truncation (original behavior)
    const relevant = this.kg.searchByText(query, 5);
    const knowledgeContext = relevant.map(r =>
      `[${r.node.type}] ${r.node.title}: ${(r.node.body || r.node.content || '').slice(0, 200)}`
    ).join('\n');

    return `Question: ${query}\n\nRelevant knowledge from my graph:\n${knowledgeContext || 'None found.'}\n\nAnswer based on this context. Be direct and concise.`;
  }

  _buildSystemPrompt() {
    return `You are a tool being used by Cortex, a cognitive engine. You provide natural language when the engine needs it. Be concise. The engine will handle context and reasoning — you provide the words.`;
  }

  _selfMaintain() {
    const actions = [];

    // Connect orphans to similar nodes
    const orphans = this.kg.orphans();
    let connected = 0;
    for (const id of orphans.slice(0, 10)) {
      const similar = this.kg.findSimilar(id, 0.2, 1);
      if (similar.length > 0) {
        this.kg.addEdge(id, similar[0].id, 'relates-to', similar[0].similarity);
        connected++;
      }
    }
    if (connected > 0) actions.push(`Connected ${connected} orphan nodes`);

    // Decay stale nodes
    const staleThreshold = Date.now() - 30 * 86400000; // 30 days
    let decayed = 0;
    for (const node of this.kg.nodes.values()) {
      if ((node.metadata?.updated || 0) < staleThreshold) {
        const conf = node.metadata?.confidence || 0.5;
        if (conf > 0.1) {
          node.metadata.confidence = Math.max(0.1, conf - 0.05);
          decayed++;
        }
      }
    }
    if (decayed > 0) actions.push(`Decayed confidence on ${decayed} stale nodes`);

    if (actions.length > 0) {
      this.save();
    }

    return actions.length > 0
      ? `Maintenance: ${actions.join('. ')}`
      : 'No maintenance needed.';
  }

  _log(message) {
    const entry = { timestamp: Date.now(), message };
    if (!this._initLog) this._initLog = [];
    this._initLog.push(entry);
    if (this.options.verbose) {
      console.log(`[Cortex] ${message}`);
    }
  }
}

module.exports = SomaEngine;
