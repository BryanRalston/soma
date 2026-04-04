// ============================================================
// CORTEX CORE — Reasoner
// Inference engine. Draws conclusions from the knowledge graph.
// Forward chaining, backward chaining, contradiction detection.
// ============================================================

class Reasoner {
  constructor(knowledgeGraph) {
    this.kg = knowledgeGraph;
    this.rules = [];
    this.conclusions = [];
    this.inferenceLog = [];
    this._seenInsightKeys = new Set();   // Dedup: fingerprints of previously seen insights
    this._seenInferenceKeys = new Set(); // Dedup: fingerprints of previously seen inferences
  }

  // ── Deduplication Helpers ──────────────────────────────────

  /**
   * Generate a stable fingerprint for an insight so we can detect repeats.
   * Based on type + the node IDs or structural features involved.
   */
  _insightKey(insight) {
    if (insight.nodeIds && insight.nodeIds.length > 0) {
      return `${insight.type}:${insight.nodeIds.sort().join(',')}`;
    }
    // Fallback: type + content hash (first 80 chars)
    const content = (insight.content || '').slice(0, 80);
    return `${insight.type}:${content}`;
  }

  /**
   * Generate a stable fingerprint for an inference/conclusion.
   */
  _inferenceKey(conclusion) {
    if (conclusion.about && conclusion.relation) {
      return `${conclusion.about}:${conclusion.relation}`;
    }
    return `inf:${(conclusion.content || '').slice(0, 80)}`;
  }

  /**
   * Load previously seen insight/inference keys from a persisted set.
   * Called by engine/pulse after initialization with data from pulse_state.
   */
  loadSeenKeys(seenInsights, seenInferences) {
    if (Array.isArray(seenInsights)) {
      for (const k of seenInsights) this._seenInsightKeys.add(k);
    }
    if (Array.isArray(seenInferences)) {
      for (const k of seenInferences) this._seenInferenceKeys.add(k);
    }
  }

  /**
   * Export seen keys for persistence.
   */
  exportSeenKeys() {
    return {
      seenInsights: [...this._seenInsightKeys],
      seenInferences: [...this._seenInferenceKeys]
    };
  }

  // ── Rule System ─────────────────────────────────────────────

  addRule(rule) {
    // rule: { name, condition: (kg) => [matching node sets], action: (matches, kg) => conclusions }
    this.rules.push(rule);
  }

  // ── Forward Chaining ────────────────────────────────────────
  // Given what we know, what can we conclude?

  forwardChain(maxIterations = 10) {
    const newConclusions = [];
    let iterations = 0;

    while (iterations < maxIterations) {
      let derived = false;

      for (const rule of this.rules) {
        const matches = rule.condition(this.kg);
        for (const match of matches) {
          const conclusion = rule.action(match, this.kg);
          if (!conclusion) continue;
          if (!this._conclusionExists(conclusion)) {
            newConclusions.push({
              ...conclusion,
              derivedBy: rule.name,
              derivedFrom: match.map(n => n.id || n),
              derivedAt: Date.now(),
              confidence: this._propagateConfidence(match)
            });
            derived = true;
          }
        }
      }

      iterations++;
      if (!derived) break;
    }

    this.conclusions.push(...newConclusions);
    if (this.conclusions.length > 5000) this.conclusions = this.conclusions.slice(-2500);

    // Deduplicate: filter out inferences we've seen in previous cycles
    const trulyNew = [];
    for (const c of newConclusions) {
      const key = this._inferenceKey(c);
      if (!this._seenInferenceKeys.has(key)) {
        this._seenInferenceKeys.add(key);
        c._isNew = true;
        trulyNew.push(c);
      }
    }

    this.inferenceLog.push({
      type: 'forward-chain',
      iterations,
      conclusionsGenerated: newConclusions.length,
      newConclusions: trulyNew.length,
      totalSeenInferences: this._seenInferenceKeys.size,
      timestamp: Date.now()
    });
    if (this.inferenceLog.length > 1000) this.inferenceLog = this.inferenceLog.slice(-500);

    // Attach dedup metadata
    newConclusions._newCount = trulyNew.length;
    newConclusions._totalSeen = this._seenInferenceKeys.size;

    return newConclusions;
  }

  _conclusionExists(conclusion) {
    return this.conclusions.some(c =>
      c.content === conclusion.content ||
      (c.about === conclusion.about && c.relation === conclusion.relation)
    );
  }

  // ── Backward Chaining ───────────────────────────────────────
  // Given a question, find supporting evidence.

  explain(nodeId, maxDepth = 4) {
    const node = this.kg.getNode(nodeId);
    if (!node) return null;

    const evidence = {
      node,
      supports: [],
      contradicts: [],
      evolvedFrom: [],
      synthesizedFrom: [],
      confidenceChain: []
    };

    const visited = new Set([nodeId]);
    const queue = [{ id: nodeId, depth: 0, role: 'root' }];

    while (queue.length > 0) {
      if (queue.length > 5000) break; // Safety valve — prevent OOM on dense graphs
      const { id, depth, role } = queue.shift();
      if (depth >= maxDepth) continue;

      const incoming = this.kg.neighbors(id, 'incoming');
      for (const { node: src, edge } of incoming) {
        if (visited.has(src.id)) continue;
        visited.add(src.id);

        const item = {
          node: src,
          edge,
          depth: depth + 1,
          confidence: src.metadata?.confidence ?? 1.0
        };

        switch (edge.type) {
          case 'supports':
            evidence.supports.push(item);
            break;
          case 'contradicts':
            evidence.contradicts.push(item);
            break;
          case 'evolves-from':
            evidence.evolvedFrom.push(item);
            break;
          case 'synthesizes':
            evidence.synthesizedFrom.push(item);
            break;
          default:
            evidence.supports.push(item);
        }

        queue.push({ id: src.id, depth: depth + 1, role: edge.type });
      }
    }

    // Calculate aggregate confidence
    evidence.aggregateConfidence = this._aggregateConfidence(evidence);

    return evidence;
  }

  // ── Confidence Propagation ──────────────────────────────────

  _propagateConfidence(nodes) {
    if (!nodes || nodes.length === 0) return 0.5;
    const confidences = nodes.map(n => {
      const node = typeof n === 'string' ? this.kg.getNode(n) : n;
      return node?.metadata?.confidence ?? 0.5;
    });
    // Geometric mean — one low-confidence source drags down the conclusion
    return Math.pow(
      confidences.reduce((prod, c) => prod * c, 1),
      1 / confidences.length
    );
  }

  _aggregateConfidence(evidence) {
    let confidence = evidence.node.metadata?.confidence ?? 0.5;

    // Supporting evidence increases confidence
    if (evidence.supports.length > 0) {
      const supportStrength = evidence.supports.reduce((sum, s) =>
        sum + (s.confidence * (s.edge.weight || 1)), 0
      ) / evidence.supports.length;
      confidence = confidence + (1 - confidence) * supportStrength * 0.3;
    }

    // Contradictions decrease confidence
    if (evidence.contradicts.length > 0) {
      const contradictionStrength = evidence.contradicts.reduce((sum, c) =>
        sum + (c.confidence * (c.edge.weight || 1)), 0
      ) / evidence.contradicts.length;
      confidence = confidence * (1 - contradictionStrength * 0.5);
    }

    return Math.max(0, Math.min(1, confidence));
  }

  // ── Contradiction Detection ─────────────────────────────────

  findContradictions() {
    const contradictions = [];
    const contradictEdges = [...this.kg.edges.values()]
      .filter(e => e.type === 'contradicts');

    for (const edge of contradictEdges) {
      const nodeA = this.kg.getNode(edge.from);
      const nodeB = this.kg.getNode(edge.to);
      if (!nodeA || !nodeB) continue;

      contradictions.push({
        nodes: [nodeA, nodeB],
        edge,
        resolution: this._suggestResolution(nodeA, nodeB)
      });
    }

    // Implicit contradiction detection is expensive (O(n²))
    // Only run on small tag groups to keep it bounded
    for (const [tag, nodeIds] of this.kg.byTag) {
      if (nodeIds.size < 2 || nodeIds.size > 20) continue; // skip large groups
      const nodes = [...nodeIds].map(id => this.kg.getNode(id)).filter(Boolean);
      for (let i = 0; i < Math.min(nodes.length, 10); i++) {
        for (let j = i + 1; j < Math.min(nodes.length, 10); j++) {
          const sharedTags = (nodes[i].metadata?.tags || [])
            .filter(t => (nodes[j].metadata?.tags || []).includes(t))
            .filter(t => !['pattern', 'cross-project', 'thought', 'observation'].includes(t));
          if (sharedTags.length >= 3) {
            // Skip nodes already connected — they're in the same reasoning chain, not contradictions
            const connected = this.kg.getEdgesBetween(nodes[i].id, nodes[j].id).length > 0
              || this.kg.getEdgesBetween(nodes[j].id, nodes[i].id).length > 0;
            if (connected) continue;
            contradictions.push({
              nodes: [nodes[i], nodes[j]],
              type: 'implicit',
              sharedTags,
              resolution: 'Review — same tags but potentially different conclusions'
            });
          }
        }
      }
      if (contradictions.length > 10) break; // cap output
    }

    return contradictions;
  }

  _suggestResolution(nodeA, nodeB) {
    const confA = nodeA.metadata?.confidence ?? 0.5;
    const confB = nodeB.metadata?.confidence ?? 0.5;
    const maturityOrder = { seed: 0, developing: 1, mature: 2, actionable: 3, implemented: 4 };
    const matA = maturityOrder[nodeA.metadata?.maturity] ?? 0;
    const matB = maturityOrder[nodeB.metadata?.maturity] ?? 0;

    if (confA > confB + 0.3) return `Favor "${nodeA.title}" (higher confidence: ${confA.toFixed(2)} vs ${confB.toFixed(2)})`;
    if (confB > confA + 0.3) return `Favor "${nodeB.title}" (higher confidence: ${confB.toFixed(2)} vs ${confA.toFixed(2)})`;
    if (matA > matB) return `Favor "${nodeA.title}" (more mature: ${nodeA.metadata.maturity} vs ${nodeB.metadata.maturity})`;
    if (matB > matA) return `Favor "${nodeB.title}" (more mature: ${nodeB.metadata.maturity} vs ${nodeA.metadata.maturity})`;
    return 'Needs human judgment — similar confidence and maturity';
  }

  // ── Analogy Finding ─────────────────────────────────────────
  // Find structurally similar subgraphs

  findAnalogies(nodeId, minSimilarity = 0.3) {
    const sourceNode = this.kg.getNode(nodeId);
    if (!sourceNode) return [];

    // Get the neighborhood structure of the source
    const sourceNbrs = this.kg.neighbors(nodeId, 'both');
    const sourceEdgeTypes = new Set(sourceNbrs.map(n => n.edge.type));
    const sourceNbrTypes = new Set(sourceNbrs.map(n => n.node.type).filter(Boolean));

    const analogies = [];

    for (const [candidateId, candidateNode] of this.kg.nodes) {
      if (candidateId === nodeId) continue;
      if (candidateNode.type !== sourceNode.type) continue; // Same type

      const candNbrs = this.kg.neighbors(candidateId, 'both');
      const candEdgeTypes = new Set(candNbrs.map(n => n.edge.type));
      const candNbrTypes = new Set(candNbrs.map(n => n.node.type).filter(Boolean));

      // Jaccard similarity of edge types
      const edgeIntersect = [...sourceEdgeTypes].filter(t => candEdgeTypes.has(t)).length;
      const edgeUnion = new Set([...sourceEdgeTypes, ...candEdgeTypes]).size;
      const edgeSim = edgeUnion > 0 ? edgeIntersect / edgeUnion : 0;

      // Jaccard similarity of neighbor types
      const nbrIntersect = [...sourceNbrTypes].filter(t => candNbrTypes.has(t)).length;
      const nbrUnion = new Set([...sourceNbrTypes, ...candNbrTypes]).size;
      const nbrSim = nbrUnion > 0 ? nbrIntersect / nbrUnion : 0;

      // Degree similarity
      const degreeSim = 1 - Math.abs(sourceNbrs.length - candNbrs.length) /
        Math.max(sourceNbrs.length, candNbrs.length, 1);

      const similarity = (edgeSim * 0.4 + nbrSim * 0.4 + degreeSim * 0.2);

      if (similarity >= minSimilarity) {
        analogies.push({
          nodeId: candidateId,
          node: candidateNode,
          similarity,
          sharedStructure: {
            edgeTypes: [...sourceEdgeTypes].filter(t => candEdgeTypes.has(t)),
            neighborTypes: [...sourceNbrTypes].filter(t => candNbrTypes.has(t))
          }
        });
      }
    }

    return analogies.sort((a, b) => b.similarity - a.similarity);
  }

  // ── Insight Generation ──────────────────────────────────────
  // Combine multiple reasoning methods to generate insights

  generateInsights(focus = null) {
    const insights = [];

    // 1. Find unresolved contradictions
    const contradictions = this.findContradictions();
    for (const c of contradictions.slice(0, 3)) {
      insights.push({
        type: 'contradiction',
        priority: 'high',
        content: `Contradiction between "${c.nodes[0]?.title || c.nodes[0]?.id}" and "${c.nodes[1]?.title || c.nodes[1]?.id}"`,
        nodeA: { title: c.nodes[0]?.title || c.nodes[0]?.id, confidence: c.nodes[0]?.metadata?.confidence },
        nodeB: { title: c.nodes[1]?.title || c.nodes[1]?.id, confidence: c.nodes[1]?.metadata?.confidence },
        resolution: c.resolution,
        nodeIds: c.nodes.map(n => n.id)
      });
    }

    // 2. Find high-confidence orphans (knowledge not connected to anything)
    const orphans = this.kg.orphans();
    const valuableOrphans = orphans
      .map(id => this.kg.getNode(id))
      .filter(n => n && (n.metadata?.confidence || 0) > 0.7)
      .slice(0, 5);
    for (const orphan of valuableOrphans) {
      if (this.kg.findSimilar) {
        const similar = this.kg.findSimilar(orphan.id, 0.15, 3);
        if (similar.length > 0) {
          insights.push({
            type: 'connection-opportunity',
            priority: 'medium',
            content: `"${orphan.title || orphan.id}" is isolated but similar to "${similar[0].node?.title || similar[0].id}"`,
            nodeA: orphan.title || orphan.id,
            nodeB: similar[0].node?.title || similar[0].id,
            similarity: similar[0].similarity,
            suggestion: `Connect with type: relates-to or supports`,
            nodeIds: [orphan.id, similar[0].id]
          });
        }
      }
    }

    // 3. Find clusters with no cross-links (siloed knowledge) — capped at 3
    const communities = this.kg.communities ? this.kg.communities() : new Map();
    if (communities.size > 1) {
      const communityList = [...communities.entries()]
        .filter(([, ids]) => ids.length > 2)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 10); // only check top 10 communities
      let siloCount = 0;
      for (let i = 0; i < communityList.length && siloCount < 3; i++) {
        for (let j = i + 1; j < communityList.length && siloCount < 3; j++) {
          const [, idsA] = communityList[i];
          const [, idsB] = communityList[j];
          let hasLink = false;
          for (const a of idsA.slice(0, 5)) {
            for (const b of idsB.slice(0, 5)) {
              if (this.kg.getEdgesBetween(a, b).length > 0 ||
                  this.kg.getEdgesBetween(b, a).length > 0) {
                hasLink = true;
                break;
              }
            }
            if (hasLink) break;
          }
          if (!hasLink) {
            insights.push({
              type: 'silo',
              priority: 'low',
              content: `Two knowledge clusters (${idsA.length} and ${idsB.length} nodes) have no connections`,
              sizeA: idsA.length,
              sizeB: idsB.length,
              suggestion: 'Look for bridging concepts between these groups'
            });
            siloCount++;
          }
        }
      }
    }

    // 4. Find mature thoughts that could become actionable
    const matureThoughts = this.kg.query({ maturity: 'mature' });
    for (const thought of matureThoughts.slice(0, 3)) {
      const evidence = this.explain(thought.id, 3);
      if (evidence && evidence.supports.length >= 2 && evidence.contradicts.length === 0) {
        insights.push({
          type: 'promotion',
          priority: 'medium',
          content: `"${thought.title}" has ${evidence.supports.length} supporting pieces and no contradictions`,
          suggestion: `Consider promoting to actionable`,
          nodeIds: [thought.id]
        });
      }
    }

    // Deduplicate: separate new insights from previously seen ones
    const newInsights = [];
    for (const insight of insights) {
      const key = this._insightKey(insight);
      if (!this._seenInsightKeys.has(key)) {
        this._seenInsightKeys.add(key);
        insight._isNew = true;
        newInsights.push(insight);
      }
    }

    // Attach dedup metadata to the returned array
    const sorted = insights.sort((a, b) => {
      const priority = { high: 3, medium: 2, low: 1 };
      return (priority[b.priority] || 0) - (priority[a.priority] || 0);
    });
    sorted._newCount = newInsights.length;
    sorted._totalSeen = this._seenInsightKeys.size;

    return sorted;
  }

  // ── Introspection ───────────────────────────────────────────

  selfReport() {
    return {
      rulesLoaded: this.rules.length,
      conclusionsDrawn: this.conclusions.length,
      inferenceLog: this.inferenceLog.slice(-10),
      capabilities: [
        'forward-chaining',
        'backward-chaining (explain)',
        'contradiction-detection',
        'analogy-finding',
        'confidence-propagation',
        'insight-generation'
      ]
    };
  }
}

// ── Built-in Rules ────────────────────────────────────────────

Reasoner.builtinRules = [
  {
    name: 'transitive-support',
    // If A supports B and B supports C, then A indirectly supports C
    condition: (kg) => {
      // Build index of support edges by source for O(E) instead of O(E²)
      const supportByFrom = new Map();
      for (const edge of kg.edges.values()) {
        if (edge.type !== 'supports') continue;
        if (!supportByFrom.has(edge.from)) supportByFrom.set(edge.from, []);
        supportByFrom.get(edge.from).push(edge);
      }
      const matches = [];
      for (const edge1 of kg.edges.values()) {
        if (edge1.type !== 'supports') continue;
        const chain = supportByFrom.get(edge1.to) || [];
        for (const edge2 of chain) {
          if (edge1.from !== edge2.to) {
            matches.push([
              kg.getNode(edge1.from),
              kg.getNode(edge1.to),
              kg.getNode(edge2.to)
            ].filter(Boolean));
          }
        }
        if (matches.length > 50) break; // cap
      }
      return matches.filter(m => m.length === 3);
    },
    action: (match) => {
      if (match.length < 3) return null;
      return {
        content: `"${match[0].title}" indirectly supports "${match[2].title}" through "${match[1].title}"`,
        about: match[0].id,
        relation: `transitive-support-to-${match[2].id}`,
        type: 'inference'
      };
    }
  },
  {
    name: 'pattern-convergence',
    // If multiple patterns share 3+ tags, they may be aspects of the same thing
    condition: (kg) => {
      const patterns = kg.query({ type: 'pattern' });
      const matches = [];
      for (let i = 0; i < patterns.length; i++) {
        for (let j = i + 1; j < patterns.length; j++) {
          const tagsA = new Set(patterns[i].metadata?.tags || []);
          const tagsB = new Set(patterns[j].metadata?.tags || []);
          const shared = [...tagsA].filter(t => tagsB.has(t));
          if (shared.length >= 3) {
            matches.push([patterns[i], patterns[j], shared]);
          }
        }
      }
      return matches;
    },
    action: (match) => {
      if (match.length < 3) return null;
      return {
        content: `Patterns "${match[0].title}" and "${match[1].title}" converge on: ${match[2].join(', ')}`,
        about: match[0].id,
        relation: `converges-with-${match[1].id}`,
        type: 'inference'
      };
    }
  },
  {
    name: 'goal-alignment',
    // If a thought mentions a goal's keywords but isn't connected to it, flag it
    condition: (kg) => {
      const goals = kg.query({ type: 'goal' });
      const matches = [];
      for (const goal of goals.slice(0, 5)) {
        const goalWords = new Set(
          `${goal.title || ''} ${goal.body || ''}`.toLowerCase()
            .split(/\s+/).filter(w => w.length > 4)
        );
        const connected = new Set(
          kg.neighbors(goal.id, 'both').map(n => n.node.id)
        );
        // Find unconnected thoughts that mention goal keywords
        for (const node of kg.nodes.values()) {
          if (node.type === 'goal' || connected.has(node.id)) continue;
          const text = `${node.title || ''} ${node.body || ''}`.toLowerCase();
          const overlap = [...goalWords].filter(w => text.includes(w));
          if (overlap.length >= 3) {
            matches.push([goal, node, overlap]);
            if (matches.length > 20) break;
          }
        }
        if (matches.length > 20) break;
      }
      return matches;
    },
    action: (match) => {
      if (match.length < 3) return null;
      return {
        content: `"${match[1].title || match[1].id}" may serve goal "${match[0].title}" (shared: ${match[2].slice(0, 5).join(', ')})`,
        about: match[1].id,
        relation: `potential-alignment-${match[0].id}`,
        type: 'inference'
      };
    }
  },
  {
    name: 'stale-high-confidence',
    // High-confidence nodes that haven't been updated in 30+ days may be outdated
    condition: (kg) => {
      const threshold = Date.now() - 30 * 86400000;
      const matches = [];
      for (const node of kg.nodes.values()) {
        if ((node.metadata?.confidence || 0) > 0.8 &&
            (node.metadata?.updated || node.metadata?.created || Date.now()) < threshold &&
            node.type !== 'goal' && node.type !== 'value') {
          matches.push([node]);
          if (matches.length > 10) break;
        }
      }
      return matches;
    },
    action: (match) => {
      if (!match[0]) return null;
      const age = Math.round((Date.now() - (match[0].metadata?.updated || match[0].metadata?.created || Date.now())) / 86400000);
      return {
        content: `"${match[0].title || match[0].id}" has high confidence (${(match[0].metadata?.confidence || 0).toFixed(2)}) but hasn't been updated in ${age} days — may need verification`,
        about: match[0].id,
        relation: 'stale-confidence-warning',
        type: 'inference'
      };
    }
  },
  {
    name: 'evolution-chain-gap',
    // If A evolved-from B and B evolved-from C, but A has no link to C, note the lineage
    condition: (kg) => {
      const evolvedByFrom = new Map();
      for (const edge of kg.edges.values()) {
        if (edge.type !== 'evolves-from') continue;
        if (!evolvedByFrom.has(edge.from)) evolvedByFrom.set(edge.from, []);
        evolvedByFrom.get(edge.from).push(edge);
      }
      const matches = [];
      for (const edge1 of kg.edges.values()) {
        if (edge1.type !== 'evolves-from') continue;
        const chain = evolvedByFrom.get(edge1.to) || [];
        for (const edge2 of chain) {
          // A (edge1.from) evolved from B (edge1.to), B evolved from C (edge2.to)
          const existing = kg.getEdgesBetween(edge1.from, edge2.to);
          if (existing.length === 0) {
            matches.push([
              kg.getNode(edge1.from),
              kg.getNode(edge1.to),
              kg.getNode(edge2.to)
            ].filter(Boolean));
          }
        }
        if (matches.length > 20) break;
      }
      return matches.filter(m => m.length === 3);
    },
    action: (match) => {
      if (match.length < 3) return null;
      return {
        content: `"${match[0].title || match[0].id}" has lineage through "${match[1].title || match[1].id}" back to "${match[2].title || match[2].id}" — consider connecting the chain`,
        about: match[0].id,
        relation: `lineage-gap-${match[2].id}`,
        type: 'inference'
      };
    }
  }
];

module.exports = Reasoner;
