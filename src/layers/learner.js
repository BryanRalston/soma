// ============================================================
// SOMA — Learning Engine
// The piece that makes Soma a mind instead of a lookup table.
// Rule learning, correction integration, decision memory.
// ============================================================

const fs = require('fs');
const path = require('path');

let _config = {};
try { _config = require('../../soma.config.js'); } catch (_) {}
const DATA_DIR = process.env.SOMA_DATA || _config.dataDir || path.join(__dirname, '../../data');
const CORRECTIONS_FILE = path.join(DATA_DIR, 'corrections_log.json');
const LEARNER_STATE_FILE = path.join(DATA_DIR, 'learner_state.json');

// Internal/structural tags and types to exclude from rule learning.
// These represent Soma's own creation artifacts (e.g., Associator synthesis nodes),
// not knowledge about the world. Without this filter, the Learner navel-gazes —
// learning rules like "synthesis→synthesis via synthesizes" with thousands of
// observations that are just reflections of its own graph-building machinery.
const INTERNAL_TAGS = new Set([
  'soma', 'capability', 'emergent-concept', 'soma-associator',
  'autonomous', 'meta', 'infrastructure'
]);
const INTERNAL_TYPES = new Set(['capability', 'meta']);

class Learner {
  constructor(knowledgeGraph, reasoner) {
    this.kg = knowledgeGraph;
    this.reasoner = reasoner;
    this.learnedRules = [];
    this.decisionLog = [];
    this.hypotheses = [];
    this.correctionIndex = new Map(); // thought_id -> corrections
    this.stats = {
      rulesLearned: 0,
      correctionsApplied: 0,
      decisionsRecorded: 0,
      hypothesesTested: 0,
      hypothesesConfirmed: 0,
      hypothesesRejected: 0
    };

    this._loadState();
    this._indexCorrections();
  }

  // ── Rule Learning ───────────────────────────────────────────
  // Watch for repeated patterns in the graph and generate new
  // inference rules automatically.

  learnRules() {
    const newRules = [];

    // Strategy 1: Frequent edge patterns
    // If nodes of type X often connect to nodes of type Y via edge Z,
    // learn: "when a new X appears, look for Y connections"
    const edgePatterns = this._findEdgePatterns();
    for (const pattern of edgePatterns) {
      const ruleName = `learned-edge-${pattern.fromType}-${pattern.edgeType}-${pattern.toType}`;
      if (pattern.count >= 3 && !this._ruleExists(ruleName)) {
        const rule = this._createEdgePatternRule(pattern);
        newRules.push(rule);
      }
    }

    // Strategy 2: Tag co-occurrence rules
    // If tags A and B appear together in 5+ nodes, and those nodes
    // often have a certain type or maturity, learn that association
    const tagPatterns = this._findTagCooccurrence();
    for (const pattern of tagPatterns) {
      const ruleName = `learned-tags-${pattern.tagA}-${pattern.tagB}`;
      if (pattern.count >= 5 && !this._ruleExists(ruleName)) {
        const rule = this._createTagCooccurrenceRule(pattern);
        newRules.push(rule);
      }
    }

    // Strategy 3: Maturity progression rules
    // If nodes that reach "mature" share certain characteristics,
    // learn to identify seed/developing nodes likely to mature
    const maturityPatterns = this._findMaturityPatterns();
    for (const pattern of maturityPatterns) {
      if (!this._ruleExists('learned-maturity-predictor')) {
        const rule = this._createMaturityRule(pattern);
        newRules.push(rule);
      }
    }

    // Register new rules with the reasoner
    for (const rule of newRules) {
      this.reasoner.addRule(rule);
      this.learnedRules.push({
        name: rule.name,
        learnedAt: Date.now(),
        source: rule.source,
        description: rule.description
      });
      this.stats.rulesLearned++;
    }

    // Cap learnedRules at 500
    if (this.learnedRules.length > 500) {
      const removed = this.learnedRules.filter(r => r.removed);
      if (removed.length > 100) this.learnedRules = this.learnedRules.filter(r => !r.removed);
    }

    this._saveState();
    return newRules;
  }

  _findEdgePatterns() {
    const patterns = new Map(); // "fromType->edgeType->toType" -> count

    for (const edge of this.kg.edges.values()) {
      const fromNode = this.kg.getNode(edge.from);
      const toNode = this.kg.getNode(edge.to);
      if (!fromNode || !toNode) continue;

      // Skip internal/structural nodes — don't learn rules about Soma's own artifacts
      if (this._isInternalNode(fromNode) || this._isInternalNode(toNode)) continue;

      const key = `${fromNode.type || 'unknown'}->${edge.type}->${toNode.type || 'unknown'}`;
      if (!patterns.has(key)) {
        patterns.set(key, { name: `edge-pattern-${key}`, fromType: fromNode.type, edgeType: edge.type, toType: toNode.type, count: 0, examples: [] });
      }
      const p = patterns.get(key);
      p.count++;
      if (p.examples.length < 3) p.examples.push({ from: edge.from, to: edge.to });
    }

    return [...patterns.values()].filter(p => p.count >= 3).sort((a, b) => b.count - a.count).slice(0, 10);
  }

  _createEdgePatternRule(pattern) {
    const { fromType, edgeType, toType, count } = pattern;
    return {
      name: `learned-edge-${fromType}-${edgeType}-${toType}`,
      source: 'learner',
      description: `${fromType} nodes frequently connect to ${toType} via ${edgeType} (observed ${count} times)`,
      condition: (kg) => {
        // Find fromType nodes that DON'T have this edge pattern yet
        const candidates = kg.query({ type: fromType });
        const matches = [];
        for (const node of candidates.slice(0, 20)) {
          const nbrs = kg.neighbors(node.id, 'outgoing');
          const hasPattern = nbrs.some(n => n.edge.type === edgeType && n.node.type === toType);
          if (!hasPattern) {
            // Find potential toType targets
            const targets = kg.query({ type: toType }).slice(0, 10);
            for (const target of targets) {
              const sim = kg.textSimilarity(node.id, target.id);
              if (sim > 0.15) {
                matches.push([node, target]);
                if (matches.length > 10) break;
              }
            }
          }
          if (matches.length > 10) break;
        }
        return matches;
      },
      action: (match) => {
        if (match.length < 2) return null;
        return {
          content: `"${match[0].title || match[0].id}" may ${edgeType} "${match[1].title || match[1].id}" (learned pattern: ${fromType}->${edgeType}->${toType})`,
          about: match[0].id,
          relation: `learned-${edgeType}-${match[1].id}`,
          type: 'learned-inference'
        };
      }
    };
  }

  _findTagCooccurrence() {
    const pairCounts = new Map(); // "tagA|tagB" -> { count, nodeTypes }

    for (const node of this.kg.nodes.values()) {
      // Skip internal/structural nodes — don't learn tautological tag co-occurrences
      if (this._isInternalNode(node)) continue;

      const tags = node.metadata?.tags || [];
      if (tags.length < 2) continue;
      for (let i = 0; i < tags.length; i++) {
        for (let j = i + 1; j < tags.length; j++) {
          const key = [tags[i], tags[j]].sort().join('|');
          if (!pairCounts.has(key)) {
            pairCounts.set(key, { name: `tag-cooccurrence-${key}`, tagA: tags[i], tagB: tags[j], count: 0, types: new Map() });
          }
          const p = pairCounts.get(key);
          p.count++;
          const type = node.type || 'unknown';
          p.types.set(type, (p.types.get(type) || 0) + 1);
        }
      }
    }

    return [...pairCounts.values()]
      .filter(p => p.count >= 5)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }

  _createTagCooccurrenceRule(pattern) {
    const { tagA, tagB, count } = pattern;
    const dominantType = [...pattern.types.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

    return {
      name: `learned-tags-${tagA}-${tagB}`,
      source: 'learner',
      description: `Tags "${tagA}" and "${tagB}" co-occur in ${count} nodes (usually type: ${dominantType})`,
      condition: (kg) => {
        // Find nodes with one tag but not the other — might be misclassified
        const withA = [...(kg.byTag.get(tagA) || [])].map(id => kg.getNode(id)).filter(Boolean);
        const withB = new Set(kg.byTag.get(tagB) || []);
        const matches = [];
        for (const node of withA.slice(0, 20)) {
          if (!withB.has(node.id)) {
            // Node has tagA but not tagB — check if it's similar to nodes that have both
            matches.push([node]);
            if (matches.length > 5) break;
          }
        }
        return matches;
      },
      action: (match) => {
        if (!match[0]) return null;
        return {
          content: `"${match[0].title || match[0].id}" has "${tagA}" but not "${tagB}" — these tags co-occur ${count} times, consider adding`,
          about: match[0].id,
          relation: `tag-suggestion-${tagB}`,
          type: 'learned-inference'
        };
      }
    };
  }

  _findMaturityPatterns() {
    // What do mature/actionable nodes have in common?
    const mature = [...this.kg.nodes.values()].filter(n =>
      n.metadata?.maturity === 'mature' || n.metadata?.maturity === 'actionable' || n.metadata?.maturity === 'implemented'
    );

    if (mature.length < 5) return [];

    // Analyze common traits
    const avgEdges = mature.reduce((sum, n) => sum + this.kg.neighbors(n.id, 'both').length, 0) / mature.length;
    const avgConfidence = mature.reduce((sum, n) => sum + (n.metadata?.confidence || 0), 0) / mature.length;

    // Count common tags
    const tagFreq = new Map();
    for (const node of mature) {
      for (const tag of (node.metadata?.tags || [])) {
        tagFreq.set(tag, (tagFreq.get(tag) || 0) + 1);
      }
    }
    const commonTags = [...tagFreq.entries()]
      .filter(([, count]) => count >= mature.length * 0.3)
      .map(([tag]) => tag);

    return [{
      name: `maturity-predictor`,
      avgEdges: Math.round(avgEdges),
      avgConfidence: avgConfidence.toFixed(2),
      commonTags,
      sampleSize: mature.length
    }];
  }

  _createMaturityRule(pattern) {
    const { avgEdges, avgConfidence } = pattern;
    const edgeThreshold = Math.max(2, Math.floor(avgEdges * 0.6));

    return {
      name: 'learned-maturity-predictor',
      source: 'learner',
      description: `Nodes with ${edgeThreshold}+ edges and high confidence tend to reach maturity (based on ${pattern.sampleSize} examples)`,
      condition: (kg) => {
        const seeds = kg.query({ maturity: 'developing' });
        const matches = [];
        for (const node of seeds.slice(0, 20)) {
          const edgeCount = kg.neighbors(node.id, 'both').length;
          const confidence = node.metadata?.confidence || 0;
          if (edgeCount >= edgeThreshold && confidence >= avgConfidence * 0.8) {
            matches.push([node, edgeCount, confidence]);
          }
          if (matches.length > 5) break;
        }
        return matches;
      },
      action: (match) => {
        if (!match[0]) return null;
        return {
          content: `"${match[0].title || match[0].id}" is developing with ${match[1]} edges and ${(match[2]).toFixed(2)} confidence — strong candidate for maturity promotion`,
          about: match[0].id,
          relation: 'maturity-candidate',
          type: 'learned-inference'
        };
      }
    };
  }

  _ruleExists(name) {
    return this.reasoner.rules.some(r => r.name === name) ||
           this.learnedRules.some(r => r.name === name);
  }

  // Check if a node is internal/structural (Soma's own artifacts).
  // These nodes should be excluded from rule learning to prevent
  // the Learner from learning tautological rules about its own machinery.
  _isInternalNode(node) {
    if (!node) return true;
    // Filter by type
    if (INTERNAL_TYPES.has(node.type)) return true;
    // Filter by tags
    const tags = node.metadata?.tags || [];
    return tags.some(t => INTERNAL_TAGS.has(t));
  }

  // ── Anomaly Learning ───────────────────────────────────────
  // Turn structural anomalies from the PatternEngine into learning
  // signals — hypotheses about miscalibrated confidence or
  // misclassified nodes.

  learnFromAnomalies(anomalies) {
    const stats = { processed: 0, hypothesesCreated: 0, skipped: 0 };
    if (!Array.isArray(anomalies) || anomalies.length === 0) return stats;

    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    for (const anomaly of anomalies) {
      // Skip anomalies about internal/structural nodes
      const node = this.kg.getNode(anomaly.nodeId);
      if (!node || this._isInternalNode(node)) {
        stats.skipped++;
        continue;
      }

      // Quality filter: skip nodes with < 3 edges (too isolated)
      const neighbors = this.kg.neighbors(anomaly.nodeId, 'both');
      if (neighbors.length < 3) {
        stats.skipped++;
        continue;
      }

      // Quality filter: skip nodes created in the last 24 hours (too new)
      const created = node.metadata?.created;
      if (created) {
        const createdTime = typeof created === 'number' ? created : new Date(created).getTime();
        if (!isNaN(createdTime) && (now - createdTime) < TWENTY_FOUR_HOURS) {
          stats.skipped++;
          continue;
        }
      }

      stats.processed++;

      // Check for duplicate hypothesis about this node (any status — don't re-create
      // hypotheses for nodes that already have one, even if confirmed/rejected/stale)
      const existingHyp = this.hypotheses.find(h =>
        h.statement.includes(anomaly.nodeId) &&
        h.tags?.includes('anomaly')
      );
      if (existingHyp) {
        stats.skipped++;
        continue;
      }

      // Per-cycle cap: don't flood the hypothesis list from a single anomaly run
      if (stats.hypothesesCreated >= 10) {
        stats.skipped++;
        continue;
      }

      // Confidence outlier anomaly
      if (anomaly.nodeConfidence !== undefined && anomaly.neighborAvgConfidence !== undefined) {
        const diff = Math.abs(anomaly.nodeConfidence - anomaly.neighborAvgConfidence);
        // Quality filter: skip minor variations (< 0.2 difference)
        if (diff < 0.2) {
          stats.skipped++;
          continue;
        }

        this.createHypothesis({
          statement: `Node ${anomaly.nodeId} may be miscalibrated — confidence ${anomaly.nodeConfidence.toFixed(2)} vs neighbor avg ${anomaly.neighborAvgConfidence.toFixed(2)}`,
          confidence: 0.4,
          domain: 'graph-integrity',
          testable: true,
          testCriteria: `Check if "${anomaly.title}" confidence aligns with its supporting evidence`,
          tags: ['anomaly', 'confidence-outlier', 'auto-generated'],
          evidenceFor: [{
            description: anomaly.reason,
            source: 'pattern-engine',
            addedAt: now
          }]
        });
        stats.hypothesesCreated++;
        continue;
      }

      // Low tag overlap anomaly — potential misclassification or cross-domain bridge
      if (anomaly.fitScore !== undefined) {
        this.createHypothesis({
          statement: `Node ${anomaly.nodeId} has low tag overlap (${(anomaly.fitScore * 100).toFixed(0)}%) with its community of ${anomaly.communitySize} — possible misclassification or cross-domain bridge`,
          confidence: 0.4,
          domain: 'graph-integrity',
          testable: true,
          testCriteria: `Examine "${anomaly.title}" — is it misclassified, or does it genuinely bridge domains? Missing tags: ${(anomaly.missingTags || []).join(', ')}`,
          tags: ['anomaly', 'tag-mismatch', 'auto-generated'],
          evidenceFor: [{
            description: anomaly.reason,
            source: 'pattern-engine',
            addedAt: now
          }]
        });
        stats.hypothesesCreated++;
      }
    }

    if (stats.hypothesesCreated > 0) {
      this._saveState();
    }

    return stats;
  }

  // ── Correction Integration ──────────────────────────────────
  // When beliefs are corrected, update the graph. Don't just log —
  // change the mind.

  applyCorrections() {
    const corrections = this._loadCorrections();
    let applied = 0;

    for (const correction of corrections) {
      // Skip if already applied
      if (correction._applied) continue;

      const affectedNodes = (correction.thought_ids || [])
        .map(id => this.kg.getNode(id))
        .filter(Boolean);

      for (const node of affectedNodes) {
        // Ensure metadata exists before any access
        if (!node.metadata) node.metadata = {};

        // 1. Reduce confidence on the corrected belief
        const oldConfidence = node.metadata.confidence || 0.5;
        const newConfidence = Math.max(0.1, oldConfidence * 0.6);
        node.metadata.confidence = newConfidence;

        // 2. Add correction marker
        if (!node.metadata.corrections) node.metadata.corrections = [];
        node.metadata.corrections.push({
          id: correction.id,
          correctedAt: correction.timestamp,
          domain: correction.domain,
          summary: (correction.correction || '').slice(0, 200)
        });

        // 3. Mark maturity regression if it was mature+
        const maturityOrder = { seed: 0, developing: 1, mature: 2, actionable: 3, implemented: 4 };
        if ((maturityOrder[node.metadata.maturity] || 0) >= 2) {
          node.metadata.maturity = 'developing';
          node.metadata.demotedAt = Date.now();
          node.metadata.demotedReason = 'correction-applied';
        }

        // 4. Propagate reduced confidence to downstream conclusions
        this._propagateCorrectionDownstream(node.id, 0.8);
      }

      // 5. Create a correction node in the graph
      if (affectedNodes.length > 0) {
        const corrNode = this.kg.addNode({
          id: `correction-${correction.id || Date.now()}`,
          type: 'correction',
          title: `Correction: ${(correction.original_belief || '').slice(0, 80)}`,
          body: correction.correction || '',
          content: correction.correction || '',
          metadata: {
            confidence: 0.9,
            maturity: 'actionable',
            tags: ['correction', correction.domain || 'general'],
            source: 'learner',
            originalBelief: correction.original_belief,
            evidence: correction.evidence
          }
        });

        // Link correction to affected nodes
        for (const node of affectedNodes) {
          this.kg.addEdge(corrNode.id, node.id, 'corrects', 0.9);
        }
      }

      correction._applied = true;
      applied++;
      this.stats.correctionsApplied++;
    }

    if (applied > 0) {
      this._saveCorrections(corrections);
      this._saveState();
    }

    return { applied, total: corrections.length };
  }

  _propagateCorrectionDownstream(nodeId, dampingFactor, depth = 0) {
    if (depth > 3) return; // Don't propagate forever

    const outgoing = this.kg.neighbors(nodeId, 'outgoing');
    for (const { node, edge } of outgoing) {
      if (edge.type === 'supports' || edge.type === 'synthesizes') {
        const oldConf = node.metadata?.confidence || 0.5;
        const reduction = (1 - dampingFactor) * Math.pow(0.5, depth);
        const newConf = Math.max(0.1, oldConf - (oldConf * reduction));
        if (node.metadata) node.metadata.confidence = newConf;

        // Recurse
        this._propagateCorrectionDownstream(node.id, dampingFactor, depth + 1);
      }
    }
  }

  // ── Decision Memory ─────────────────────────────────────────
  // Record decisions and their contexts. Over time, build a model
  // of which decisions work in which contexts.

  recordDecision(decision) {
    const entry = {
      id: `dec-${Date.now()}`,
      timestamp: Date.now(),
      context: decision.context || {},
      query: decision.query || '',
      options: decision.options || [],
      chosen: decision.chosen || '',
      reasoning: decision.reasoning || '',
      outcome: null, // filled in later
      confidence: decision.confidence || 0.5,
      tags: decision.tags || []
    };

    this.decisionLog.push(entry);
    if (this.decisionLog.length > 500) this.decisionLog.shift();

    this.stats.decisionsRecorded++;
    this._saveState();
    return entry;
  }

  recordOutcome(decisionId, outcome) {
    const decision = this.decisionLog.find(d => d.id === decisionId);
    if (!decision) return null;

    decision.outcome = {
      success: outcome.success,
      notes: outcome.notes || '',
      recordedAt: Date.now()
    };

    // Reinforce or weaken similar future decisions
    if (outcome.success) {
      decision.confidence = Math.min(1, decision.confidence + 0.1);
    } else {
      decision.confidence = Math.max(0.1, decision.confidence - 0.15);
    }

    this._saveState();
    return decision;
  }

  // Find past decisions similar to the current context
  findSimilarDecisions(query, tags = [], limit = 5) {
    const queryWords = new Set(query.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const tagSet = new Set(tags);

    const scored = this.decisionLog
      .filter(d => d.outcome) // only decisions with known outcomes
      .map(d => {
        let score = 0;

        // Query word overlap
        const decWords = new Set(`${d.query} ${d.chosen} ${d.reasoning}`.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        const overlap = [...queryWords].filter(w => decWords.has(w)).length;
        score += overlap * 0.3;

        // Tag overlap
        const tagOverlap = d.tags.filter(t => tagSet.has(t)).length;
        score += tagOverlap * 0.4;

        // Recency bonus
        const age = (Date.now() - d.timestamp) / (86400000 * 30); // months
        score += Math.max(0, 0.2 - age * 0.02);

        // Outcome-weighted
        if (d.outcome.success) score *= 1.3;
        else score *= 0.7;

        return { decision: d, score };
      })
      .filter(s => s.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored;
  }

  // ── Hypothesis Testing ──────────────────────────────────────
  // Soma generates hypotheses. Track which ones prove true.

  createHypothesis(hypothesis) {
    const entry = {
      id: `hyp-${Date.now()}`,
      created: Date.now(),
      statement: hypothesis.statement,
      evidence_for: hypothesis.evidenceFor || [],
      evidence_against: hypothesis.evidenceAgainst || [],
      confidence: hypothesis.confidence || 0.5,
      domain: hypothesis.domain || 'general',
      testable: hypothesis.testable || false,
      test_criteria: hypothesis.testCriteria || '',
      status: 'open', // open, confirmed, rejected, revised
      tags: hypothesis.tags || []
    };

    // Dedup: skip if an identical statement already exists
    const duplicate = this.hypotheses.find(h => h.statement === entry.statement);
    if (duplicate) return duplicate;

    this.hypotheses.push(entry);
    // Cap hypotheses at 300 — prune resolved/old ones first, never blindly slice
    if (this.hypotheses.length > 300) {
      // Priority removal: rejected/abandoned first, then confirmed, then oldest stale
      const removable = this.hypotheses.filter(h =>
        h.status === 'rejected' || h.status === 'abandoned'
      );
      if (removable.length > 50) {
        const removeSet = new Set(removable.slice(0, removable.length - 20).map(h => h.id));
        this.hypotheses = this.hypotheses.filter(h => !removeSet.has(h.id));
      }
      // If still over 300, remove oldest confirmed
      if (this.hypotheses.length > 300) {
        const confirmed = this.hypotheses.filter(h => h.status === 'confirmed');
        if (confirmed.length > 20) {
          const removeSet = new Set(confirmed.slice(0, confirmed.length - 20).map(h => h.id));
          this.hypotheses = this.hypotheses.filter(h => !removeSet.has(h.id));
        }
      }
      // Last resort: hard cap at 300
      if (this.hypotheses.length > 300) {
        this.hypotheses = this.hypotheses.slice(-300);
      }
    }
    this.stats.hypothesesTested++;
    this._saveState();
    return entry;
  }

  evaluateHypothesis(hypothesisId, evidence) {
    const hyp = this.hypotheses.find(h => h.id === hypothesisId);
    if (!hyp) return null;

    if (evidence.supports) {
      hyp.evidence_for.push({
        description: evidence.description,
        source: evidence.source || 'observation',
        addedAt: Date.now()
      });
      hyp.confidence = Math.min(0.95, hyp.confidence + 0.1);
    } else {
      hyp.evidence_against.push({
        description: evidence.description,
        source: evidence.source || 'observation',
        addedAt: Date.now()
      });
      hyp.confidence = Math.max(0.05, hyp.confidence - 0.15);
    }

    // Auto-resolve if evidence is overwhelming
    if (hyp.confidence >= 0.85 && hyp.evidence_for.length >= 3) {
      hyp.status = 'confirmed';
      this.stats.hypothesesConfirmed++;

      // Strengthen related rules
      this._reinforceFromHypothesis(hyp, true);
    } else if (hyp.confidence <= 0.2 && hyp.evidence_against.length >= 2) {
      hyp.status = 'rejected';
      this.stats.hypothesesRejected++;

      // Weaken related rules
      this._reinforceFromHypothesis(hyp, false);
    }

    this._saveState();
    return hyp;
  }

  _reinforceFromHypothesis(hypothesis, confirmed) {
    // Find rules that produced conclusions related to this hypothesis
    for (const rule of this.learnedRules) {
      const ruleKeywords = rule.description.toLowerCase().split(/\s+/);
      const hypKeywords = hypothesis.statement.toLowerCase().split(/\s+/);
      const overlap = ruleKeywords.filter(w => hypKeywords.includes(w) && w.length > 4).length;

      if (overlap >= 2) {
        if (confirmed) {
          rule.reinforcements = (rule.reinforcements || 0) + 1;
        } else {
          rule.weakened = (rule.weakened || 0) + 1;
          // If weakened too many times, remove the rule
          if ((rule.weakened || 0) >= 3 && (rule.reinforcements || 0) < rule.weakened) {
            const idx = this.reasoner.rules.findIndex(r => r.name === rule.name);
            if (idx >= 0) {
              this.reasoner.rules.splice(idx, 1);
              rule.removed = true;
              rule.removedAt = Date.now();
            }
          }
        }
      }
    }
  }

  // ── Auto-Hypothesize ────────────────────────────────────────
  // Generate hypotheses from current graph state

  generateHypotheses() {
    const newHypotheses = [];

    // 1. Pattern-based: if we see a pattern emerging, hypothesize it will continue
    const recentNodes = [...this.kg.nodes.values()]
      .filter(n => n.metadata?.created && Date.now() - new Date(n.metadata.created).getTime() < 7 * 86400000)
      .slice(0, 50);

    const typeCounts = new Map();
    for (const node of recentNodes) {
      const type = node.type || 'unknown';
      typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
    }

    // If one type is dominating recent additions, hypothesize why
    for (const [type, count] of typeCounts) {
      if (count >= 5 && count / recentNodes.length > 0.3) {
        // Check any status — don't re-create if one already exists (even resolved)
        const existing = this.hypotheses.find(h =>
          h.statement.includes(`"${type}"`) && h.statement.includes('dominant')
        );
        if (!existing) {
          newHypotheses.push(this.createHypothesis({
            statement: `"${type}" is the dominant node type in recent activity (${count}/${recentNodes.length}) — this reflects current focus area`,
            confidence: 0.6,
            domain: 'meta-cognition',
            tags: ['auto-generated', 'pattern', type]
          }));
        }
      }
    }

    // 2. Confidence-drift: if average confidence in a domain is dropping, hypothesize instability
    const domains = new Map();
    for (const node of this.kg.nodes.values()) {
      for (const tag of (node.metadata?.tags || [])) {
        if (!domains.has(tag)) domains.set(tag, []);
        domains.get(tag).push(node.metadata?.confidence || 0.5);
      }
    }

    for (const [domain, confidences] of domains) {
      if (confidences.length < 10) continue;
      const avg = confidences.reduce((a, b) => a + b, 0) / confidences.length;
      if (avg < 0.4) {
        // Check any status — don't re-create if one already exists (even resolved)
        const existing = this.hypotheses.find(h =>
          h.statement.includes(`"${domain}"`) && h.statement.includes('unstable')
        );
        if (!existing) {
          newHypotheses.push(this.createHypothesis({
            statement: `Knowledge in domain "${domain}" is unstable (avg confidence: ${avg.toFixed(2)}) — may need verification or correction`,
            confidence: 0.5,
            domain,
            tags: ['auto-generated', 'confidence-drift', domain]
          }));
        }
      }
    }

    return newHypotheses;
  }

  // ── Hypothesis Batch Evaluation ───────────────────────────
  // Evaluate all open hypotheses against current graph state.
  // Called by the daemon every 5th cycle to close the loop:
  // generate → evaluate → confirm/reject/stale/abandon.

  evaluateHypothesesBatch() {
    const stats = { evaluated: 0, confirmed: 0, rejected: 0, stale: 0, abandoned: 0 };
    const now = Date.now();
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000;

    const open = this.hypotheses.filter(h => h.status === 'open' || h.status === 'stale');
    if (open.length === 0) return stats;

    for (const hyp of open) {
      const age = now - hyp.created;

      // Handle abandoned: stale for 60+ days with no new evidence
      if (hyp.status === 'stale') {
        const lastEvidence = this._lastEvidenceTime(hyp);
        const staleSince = hyp.staleAt || hyp.created;
        if (now - staleSince >= SIXTY_DAYS && (!lastEvidence || lastEvidence < staleSince)) {
          hyp.status = 'abandoned';
          hyp.abandonedAt = now;
          stats.abandoned++;
          stats.evaluated++;
          continue;
        }
      }

      // Evaluate open hypotheses against current graph state
      if (hyp.status === 'open') {
        const evidence = this._gatherEvidenceFromGraph(hyp);

        if (evidence) {
          // Use existing evaluateHypothesis to apply evidence and auto-resolve
          this.evaluateHypothesis(hyp.id, evidence);
          stats.evaluated++;

          if (hyp.status === 'confirmed') {
            stats.confirmed++;
          } else if (hyp.status === 'rejected') {
            stats.rejected++;
          } else {
            // evaluateHypothesis uses 0.85/3 and 0.2/2 thresholds, but the spec
            // asks for 0.85 confirm and 0.3 reject — apply the stricter reject check
            if (hyp.confidence < 0.3 && hyp.evidence_against.length >= 1) {
              hyp.status = 'rejected';
              hyp.rejectedAt = now;
              this.stats.hypothesesRejected++;
              stats.rejected++;
              this._reinforceFromHypothesis(hyp, false);
            }
          }
        } else {
          stats.evaluated++;
        }

        // Stale check: open 30+ days with no meaningful confidence change
        if (hyp.status === 'open' && age >= THIRTY_DAYS) {
          hyp.status = 'stale';
          hyp.staleAt = now;
          hyp.confidence = Math.max(0.1, hyp.confidence - 0.1);
          stats.stale++;
        }
      }
    }

    // Update global stats
    this.stats.hypothesesTested += stats.evaluated;

    if (stats.evaluated > 0) {
      this._saveState();
    }

    return stats;
  }

  // Gather evidence for a hypothesis from the current graph state.
  // Checks if the hypothesis claim still holds (or has weakened/strengthened).
  // Returns an evidence object for evaluateHypothesis(), or null if no signal.

  _gatherEvidenceFromGraph(hyp) {
    const statement = (hyp.statement || '').toLowerCase();

    // Type 1: Dominant type hypotheses — "X is the dominant node type"
    // Re-check whether the type is still dominant in recent nodes
    if (statement.includes('dominant') && statement.includes('node type')) {
      const typeMatch = statement.match(/"([^"]+)" is the dominant/);
      if (typeMatch) {
        const targetType = typeMatch[1];
        const recentNodes = [...this.kg.nodes.values()]
          .filter(n => n.metadata?.created && Date.now() - new Date(n.metadata.created).getTime() < 7 * 86400000)
          .slice(0, 50);

        if (recentNodes.length < 3) return null; // not enough data

        const typeCount = recentNodes.filter(n => (n.type || 'unknown') === targetType).length;
        const ratio = typeCount / recentNodes.length;

        if (ratio > 0.3) {
          return {
            supports: true,
            description: `"${targetType}" still dominant: ${typeCount}/${recentNodes.length} recent nodes (${(ratio * 100).toFixed(0)}%)`,
            source: 'graph-recheck'
          };
        } else {
          return {
            supports: false,
            description: `"${targetType}" no longer dominant: only ${typeCount}/${recentNodes.length} recent nodes (${(ratio * 100).toFixed(0)}%)`,
            source: 'graph-recheck'
          };
        }
      }
    }

    // Type 2: Confidence drift / unstable domain hypotheses
    if (statement.includes('unstable') && statement.includes('confidence')) {
      const domainMatch = statement.match(/domain "([^"]+)"/);
      if (domainMatch) {
        const domain = domainMatch[1];
        const domainNodes = [...this.kg.nodes.values()]
          .filter(n => (n.metadata?.tags || []).includes(domain));

        if (domainNodes.length < 5) return null;

        const avgConf = domainNodes.reduce((sum, n) => sum + (n.metadata?.confidence || 0.5), 0) / domainNodes.length;

        if (avgConf < 0.4) {
          return {
            supports: true,
            description: `Domain "${domain}" still unstable: avg confidence ${avgConf.toFixed(2)} across ${domainNodes.length} nodes`,
            source: 'graph-recheck'
          };
        } else {
          return {
            supports: false,
            description: `Domain "${domain}" stabilized: avg confidence ${avgConf.toFixed(2)} across ${domainNodes.length} nodes`,
            source: 'graph-recheck'
          };
        }
      }
    }

    // No recognizable hypothesis pattern — can't gather evidence
    return null;
  }

  // Get the timestamp of the most recent evidence added to a hypothesis.
  _lastEvidenceTime(hyp) {
    const forTimes = (hyp.evidence_for || []).map(e => e.addedAt || 0);
    const againstTimes = (hyp.evidence_against || []).map(e => e.addedAt || 0);
    const all = [...forTimes, ...againstTimes];
    return all.length > 0 ? Math.max(...all) : null;
  }

  // ── Persistence ─────────────────────────────────────────────

  _loadState() {
    try {
      if (!fs.existsSync(LEARNER_STATE_FILE)) return;
      const data = JSON.parse(fs.readFileSync(LEARNER_STATE_FILE, 'utf8'));
      this.learnedRules = data.learnedRules || [];
      this.decisionLog = data.decisionLog || [];
      this.hypotheses = data.hypotheses || [];
      this.stats = { ...this.stats, ...(data.stats || {}) };
    } catch (e) { console.error(`[Learner] Failed to load state: ${e.message}`); }
  }

  _saveState() {
    try {
      fs.writeFileSync(LEARNER_STATE_FILE, JSON.stringify({
        learnedRules: this.learnedRules,
        decisionLog: this.decisionLog.slice(-500),
        hypotheses: this.hypotheses.slice(-300),
        stats: this.stats,
        savedAt: Date.now()
      }, null, 2));
    } catch (e) { console.error(`[Learner] Failed to save state: ${e.message}`); }
  }

  _loadCorrections() {
    try {
      if (!fs.existsSync(CORRECTIONS_FILE)) return [];
      const raw = JSON.parse(fs.readFileSync(CORRECTIONS_FILE, 'utf8'));
      return raw.corrections || [];
    } catch (e) {
      console.error(`[Learner] Failed to load corrections: ${e.message}`);
      return [];
    }
  }

  _saveCorrections(corrections) {
    try {
      const raw = JSON.parse(fs.readFileSync(CORRECTIONS_FILE, 'utf8'));
      raw.corrections = corrections;
      fs.writeFileSync(CORRECTIONS_FILE, JSON.stringify(raw, null, 2));
    } catch (e) { console.error(`[Learner] Failed to save corrections: ${e.message}`); }
  }

  _indexCorrections() {
    const corrections = this._loadCorrections();
    for (const c of corrections) {
      for (const id of (c.thought_ids || [])) {
        if (!this.correctionIndex.has(id)) this.correctionIndex.set(id, []);
        this.correctionIndex.get(id).push(c);
      }
    }
  }

  // ── Self-Report ─────────────────────────────────────────────

  selfReport() {
    return {
      learnedRules: this.learnedRules.length,
      activeLearnedRules: this.learnedRules.filter(r => !r.removed).length,
      removedRules: this.learnedRules.filter(r => r.removed).length,
      decisions: this.decisionLog.length,
      decisionsWithOutcomes: this.decisionLog.filter(d => d.outcome).length,
      hypotheses: {
        total: this.hypotheses.length,
        open: this.hypotheses.filter(h => h.status === 'open').length,
        confirmed: this.hypotheses.filter(h => h.status === 'confirmed').length,
        rejected: this.hypotheses.filter(h => h.status === 'rejected').length,
        stale: this.hypotheses.filter(h => h.status === 'stale').length,
        abandoned: this.hypotheses.filter(h => h.status === 'abandoned').length
      },
      corrections: this.stats.correctionsApplied,
      stats: this.stats
    };
  }
}

module.exports = Learner;
