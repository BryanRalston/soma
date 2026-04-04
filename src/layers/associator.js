// SOMA — Associator / Layer 3: What do I know that I don't know I know?
//
// Discovers emergent connections across the knowledge graph that no one
// explicitly created. Structural analogies, missing link prediction,
// emergent concept extraction, semantic bridge discovery.
//
// Zero tokens. Pure graph computation.
// ============================================================

const fs = require('fs');
const path = require('path');

let _config = {};
try { _config = require('../../soma.config.js'); } catch (_) {}
const DATA_DIR = process.env.SOMA_DATA || _config.dataDir || path.join(__dirname, '../../data');
const CACHE_FILE = path.join(DATA_DIR, 'associator_cache.json');
const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

class Associator {
  constructor(knowledgeGraph) {
    this.kg = knowledgeGraph;
    this.cache = this._loadCache();
  }

  // ── Cache Management ──────────────────────────────────────────

  _loadCache() {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
        const data = JSON.parse(raw);
        // Validate structure
        if (data && typeof data === 'object' && data.concepts && data.links && data.bridges) {
          return data;
        }
      }
    } catch (err) {
      console.error(`[Associator] Cache load failed (starting fresh): ${err.message}`);
    }
    return { concepts: {}, links: {}, bridges: {} };
  }

  _saveCache() {
    try {
      // Expire old entries before saving
      const now = Date.now();
      for (const [key, ts] of Object.entries(this.cache.concepts)) {
        if (now - ts > CACHE_MAX_AGE) delete this.cache.concepts[key];
      }
      for (const [key, ts] of Object.entries(this.cache.links)) {
        if (now - ts > CACHE_MAX_AGE) delete this.cache.links[key];
      }
      for (const [key, ts] of Object.entries(this.cache.bridges)) {
        if (now - ts > CACHE_MAX_AGE) delete this.cache.bridges[key];
      }
      fs.writeFileSync(CACHE_FILE, JSON.stringify(this.cache, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[Associator] Cache save failed: ${err.message}`);
    }
  }

  _conceptFingerprint(topTerms) {
    return topTerms.slice(0, 3).map(t => t.toLowerCase().trim()).sort().join('|');
  }

  _linkFingerprint(fromId, toId) {
    return [fromId, toId].sort().join('|');
  }

  _bridgeFingerprint(communityA, communityB) {
    // Use sorted top tags as community identity
    const keyA = (communityA.topTags || []).slice(0, 3).sort().join(',');
    const keyB = (communityB.topTags || []).slice(0, 3).sort().join(',');
    return [keyA, keyB].sort().join('||');
  }

  // ── Structural Analogies ──────────────────────────────────────
  // Find node pairs that play similar *roles* in the graph but aren't
  // connected and are in different topic areas. These are nodes that
  // look different on the surface but function similarly — real analogies.

  structuralAnalogies(limit = 10) {
    try {
    const nodes = [...this.kg.nodes.values()];
    if (nodes.length < 2) return [];

    // Build role vectors for all nodes
    // Role vector: [inDegree, outDegree, numEdgeTypes, numTags, confidence]
    const roleVectors = new Map();
    const edgeTypeSets = new Map();

    for (const node of nodes) {
      const inEdges = this.kg.reverseAdj.get(node.id) || new Set();
      const outEdges = this.kg.adjacency.get(node.id) || new Set();

      // Collect unique edge types for this node
      const edgeTypes = new Set();
      for (const eid of inEdges) {
        const edge = this.kg.getEdge(eid);
        if (edge) edgeTypes.add(edge.type);
      }
      for (const eid of outEdges) {
        const edge = this.kg.getEdge(eid);
        if (edge) edgeTypes.add(edge.type);
      }

      edgeTypeSets.set(node.id, edgeTypes);

      const vec = [
        inEdges.size,
        outEdges.size,
        edgeTypes.size,
        (node.metadata?.tags || []).length,
        node.metadata?.confidence || 0.5
      ];

      roleVectors.set(node.id, vec);
    }

    // Normalize the vectors (per-dimension min-max)
    const dims = 5;
    const mins = new Array(dims).fill(Infinity);
    const maxs = new Array(dims).fill(-Infinity);

    for (const vec of roleVectors.values()) {
      for (let d = 0; d < dims; d++) {
        if (vec[d] < mins[d]) mins[d] = vec[d];
        if (vec[d] > maxs[d]) maxs[d] = vec[d];
      }
    }

    const normalized = new Map();
    for (const [id, vec] of roleVectors) {
      const norm = vec.map((v, d) => {
        const range = maxs[d] - mins[d];
        return range === 0 ? 0 : (v - mins[d]) / range;
      });
      normalized.set(id, norm);
    }

    // Sample pairs for performance — don't compare all n*(n-1)/2
    // Stratified sampling: pick nodes from different types to increase
    // the chance of finding cross-domain analogies
    const byType = new Map();
    for (const node of nodes) {
      const t = node.type || 'unknown';
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t).push(node);
    }

    const sampleSize = Math.min(nodes.length, 150);
    const sampled = [];
    const typeKeys = [...byType.keys()];
    const perType = Math.ceil(sampleSize / typeKeys.length);
    for (const type of typeKeys) {
      const typeNodes = byType.get(type);
      const shuffled = typeNodes.slice().sort(() => Math.random() - 0.5);
      sampled.push(...shuffled.slice(0, perType));
    }

    // Build TF-IDF for text similarity filtering
    const { vectors: tfidfVectors } = this.kg._buildTFIDF();

    // Compare pairs
    const results = [];
    for (let i = 0; i < sampled.length; i++) {
      if (results.length >= 200) break; // Cap output to prevent explosion
      for (let j = i + 1; j < sampled.length; j++) {
        const a = sampled[i];
        const b = sampled[j];

        // Skip if same type (we want cross-domain)
        if (a.type && b.type && a.type === b.type) continue;

        // Skip if already connected
        const aNeighborIds = new Set(
          this.kg.neighbors(a.id, 'both').map(n => n.node.id)
        );
        if (aNeighborIds.has(b.id)) continue;

        // Compute structural similarity (cosine of role vectors)
        const vecA = normalized.get(a.id);
        const vecB = normalized.get(b.id);
        if (!vecA || !vecB) continue;

        const structural = this._cosineSimilarityArrays(vecA, vecB);
        if (structural < 0.7) continue;

        // Compute text similarity — must be LOW for a real analogy
        const tfidfA = tfidfVectors.get(a.id);
        const tfidfB = tfidfVectors.get(b.id);
        let textSim = 0;
        if (tfidfA && tfidfB) {
          textSim = this.kg.cosineSimilarity(tfidfA, tfidfB);
        }
        if (textSim >= 0.15) continue;

        // Derive domain labels from tags
        const domainA = (a.metadata?.tags || []).filter(t => !['soma', 'capability', 'pattern'].includes(t)).slice(0, 3).join(', ') || a.type || 'unknown';
        const domainB = (b.metadata?.tags || []).filter(t => !['soma', 'capability', 'pattern'].includes(t)).slice(0, 3).join(', ') || b.type || 'unknown';

        results.push({
          nodeA: { id: a.id, title: a.title, type: a.type, tags: a.metadata?.tags || [] },
          nodeB: { id: b.id, title: b.title, type: b.type, tags: b.metadata?.tags || [] },
          structuralSimilarity: Math.round(structural * 1000) / 1000,
          textSimilarity: Math.round(textSim * 1000) / 1000,
          insight: `"${a.title || a.id}" plays a similar role in [${domainA}] as "${b.title || b.id}" does in [${domainB}]`
        });
      }
    }

    return results
      .sort((a, b) => b.structuralSimilarity - a.structuralSimilarity)
      .slice(0, limit);
    } catch (err) {
      console.error(`[Associator] structuralAnalogies failed: ${err.message}`);
      return [];
    }
  }

  // ── Missing Link Prediction ───────────────────────────────────
  // Predict edges that should exist but don't, using common-neighbor
  // metrics: Jaccard coefficient + Adamic-Adar index.

  predictLinks(limit = 20) {
    try {
    const results = [];
    const nodeIds = [...this.kg.nodes.keys()];

    // For each node, get its 2-hop neighborhood and only check pairs
    // within that set. This keeps it O(n * avg_degree^2) instead of O(n^2).
    const checked = new Set(); // "idA|idB" dedup

    for (const nodeId of nodeIds) {
      const directNeighbors = this.kg.neighbors(nodeId, 'both');
      const neighborIds = new Set(directNeighbors.map(n => n.node.id));

      // 2-hop: neighbors of neighbors
      const twoHopIds = new Set();
      for (const { node: nbr } of directNeighbors) {
        const nbrNeighbors = this.kg.neighbors(nbr.id, 'both');
        for (const { node: nn } of nbrNeighbors) {
          if (nn.id !== nodeId && !neighborIds.has(nn.id)) {
            twoHopIds.add(nn.id);
          }
        }
      }

      // Check each 2-hop node as a candidate link
      for (const candidateId of twoHopIds) {
        const pairKey = [nodeId, candidateId].sort().join('|');
        if (checked.has(pairKey)) continue;
        checked.add(pairKey);

        // Already directly connected? Skip.
        if (this.kg.getEdgesBetween(nodeId, candidateId).length > 0 ||
            this.kg.getEdgesBetween(candidateId, nodeId).length > 0) continue;

        // Common neighbors
        const neighborsA = new Set(this.kg.neighbors(nodeId, 'both').map(n => n.node.id));
        const neighborsB = new Set(this.kg.neighbors(candidateId, 'both').map(n => n.node.id));

        const common = [...neighborsA].filter(id => neighborsB.has(id));
        if (common.length < 2) continue;

        // Jaccard coefficient
        const union = new Set([...neighborsA, ...neighborsB]);
        const jaccard = common.length / union.size;

        // Adamic-Adar index
        let adamicAdar = 0;
        for (const commonId of common) {
          const degree = this.kg.neighbors(commonId, 'both').length;
          if (degree > 1) {
            adamicAdar += 1 / Math.log(degree);
          }
        }

        // Normalize Adamic-Adar to 0-1 range (approximate)
        const maxAA = common.length; // theoretical max when all common neighbors have degree 2
        const normalizedAA = maxAA > 0 ? Math.min(1, adamicAdar / maxAA) : 0;

        // Combined score
        const score = jaccard * 0.4 + normalizedAA * 0.6;
        if (score < 0.05) continue;

        const nodeA = this.kg.getNode(nodeId);
        const nodeB = this.kg.getNode(candidateId);
        const commonTitles = common
          .map(id => this.kg.getNode(id)?.title || id)
          .slice(0, 5);

        results.push({
          from: { id: nodeId, title: nodeA?.title || nodeId },
          to: { id: candidateId, title: nodeB?.title || candidateId },
          score: Math.round(score * 1000) / 1000,
          jaccard: Math.round(jaccard * 1000) / 1000,
          adamicAdar: Math.round(adamicAdar * 1000) / 1000,
          commonNeighbors: common,
          reason: `Both connected to: ${commonTitles.join(', ')}`
        });
      }
    }

    // Dedup: filter out link pairs seen in the last 7 days
    const now = Date.now();
    let linksFiltered = 0;
    const dedupedResults = results.filter(link => {
      const fp = this._linkFingerprint(link.from.id, link.to.id);
      const lastSeen = this.cache.links[fp];
      if (lastSeen && (now - lastSeen) < CACHE_MAX_AGE) {
        linksFiltered++;
        return false;
      }
      this.cache.links[fp] = now;
      return true;
    });

    this._lastLinksFiltered = linksFiltered;

    return dedupedResults
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    } catch (err) {
      console.error(`[Associator] predictLinks failed: ${err.message}`);
      return [];
    }
  }

  // ── Emergent Concept Extraction ───────────────────────────────
  // Find groups of nodes that are textually similar but NOT graph-connected,
  // then name the implicit concept they share.

  extractEmergentConcepts(minClusterSize = 3, similarityThreshold = 0.25) {
    try {
    const nodeIds = [...this.kg.nodes.keys()];
    if (nodeIds.length < minClusterSize) return [];

    // Build TF-IDF vectors
    const { vectors: tfidfVectors, idf } = this.kg._buildTFIDF();

    // For sampled nodes, find their top-5 most textually similar nodes.
    // Sample to cap at ~300 nodes for performance (avoids O(n^2) on large graphs).
    const sampleLimit = Math.min(nodeIds.length, 300);
    const sampledIds = nodeIds.length <= sampleLimit
      ? nodeIds
      : nodeIds.slice().sort(() => Math.random() - 0.5).slice(0, sampleLimit);

    // Build an affinity graph from these similarity edges
    const affinityEdges = new Map(); // nodeId -> Set<nodeId>
    for (const id of nodeIds) {
      if (!affinityEdges.has(id)) affinityEdges.set(id, new Set());
    }

    for (const id of sampledIds) {
      const similar = this.kg.findSimilar(id, similarityThreshold, 5);
      for (const s of similar) {
        if (!affinityEdges.has(id)) affinityEdges.set(id, new Set());
        if (!affinityEdges.has(s.id)) affinityEdges.set(s.id, new Set());
        affinityEdges.get(id).add(s.id);
        affinityEdges.get(s.id).add(id);
      }
    }

    // Find connected components in the affinity graph
    const visited = new Set();
    const components = [];

    for (const startId of nodeIds) {
      if (visited.has(startId)) continue;
      if (!affinityEdges.has(startId) || affinityEdges.get(startId).size === 0) {
        visited.add(startId);
        continue;
      }

      const component = [];
      const queue = [startId];
      while (queue.length > 0) {
        const current = queue.shift();
        if (visited.has(current)) continue;
        visited.add(current);
        component.push(current);

        const neighbors = affinityEdges.get(current) || new Set();
        for (const nbr of neighbors) {
          if (!visited.has(nbr)) queue.push(nbr);
        }
      }

      if (component.length >= minClusterSize) {
        components.push(component);
      }
    }

    // For each component: check how many are NOT connected in the real KG
    const concepts = [];
    for (const component of components) {
      let graphConnected = 0;
      let totalPairs = 0;

      for (let i = 0; i < component.length; i++) {
        for (let j = i + 1; j < component.length; j++) {
          totalPairs++;
          const edgesAB = this.kg.getEdgesBetween(component[i], component[j]);
          const edgesBA = this.kg.getEdgesBetween(component[j], component[i]);
          if (edgesAB.length > 0 || edgesBA.length > 0) {
            graphConnected++;
          }
        }
      }

      const connectedness = totalPairs > 0 ? graphConnected / totalPairs : 0;

      // Only interesting if most AREN'T connected in the real graph
      if (connectedness > 0.5) continue;

      // Compute average text similarity within the cluster
      let totalSim = 0;
      let simCount = 0;
      for (let i = 0; i < component.length && i < 20; i++) {
        for (let j = i + 1; j < component.length && j < 20; j++) {
          const vecA = tfidfVectors.get(component[i]);
          const vecB = tfidfVectors.get(component[j]);
          if (vecA && vecB) {
            totalSim += this.kg.cosineSimilarity(vecA, vecB);
            simCount++;
          }
        }
      }
      const avgSimilarity = simCount > 0 ? totalSim / simCount : 0;

      // Name the concept by finding top shared TF-IDF terms
      const termScores = new Map();
      for (const id of component) {
        const vec = tfidfVectors.get(id);
        if (!vec) continue;
        for (const [term, score] of vec) {
          termScores.set(term, (termScores.get(term) || 0) + score);
        }
      }
      const topTerms = [...termScores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([term]) => term);

      const conceptName = topTerms.slice(0, 3).join(' / ');

      concepts.push({
        concept: conceptName,
        nodes: component.map(id => {
          const node = this.kg.getNode(id);
          return { id, title: node?.title || id };
        }),
        avgSimilarity: Math.round(avgSimilarity * 1000) / 1000,
        graphConnectedness: Math.round(connectedness * 1000) / 1000,
        topTerms
      });
    }

    // Dedup: filter out concepts seen in the last 7 days
    const now = Date.now();
    let conceptsFiltered = 0;
    const dedupedConcepts = concepts.filter(concept => {
      const fp = this._conceptFingerprint(concept.topTerms);
      const lastSeen = this.cache.concepts[fp];
      if (lastSeen && (now - lastSeen) < CACHE_MAX_AGE) {
        conceptsFiltered++;
        return false;
      }
      // New finding — record it
      this.cache.concepts[fp] = now;
      return true;
    });

    // Stash the filtered count so analyze() can read it
    this._lastConceptsFiltered = conceptsFiltered;

    return dedupedConcepts.sort((a, b) => {
      // Prefer: lower connectedness (more emergent) + higher similarity (more coherent)
      const scoreA = a.avgSimilarity * (1 - a.graphConnectedness);
      const scoreB = b.avgSimilarity * (1 - b.graphConnectedness);
      return scoreB - scoreA;
    });
    } catch (err) {
      console.error(`[Associator] extractEmergentConcepts failed: ${err.message}`);
      return [];
    }
  }

  // ── Semantic Bridge Discovery ─────────────────────────────────
  // Find pairs of communities that should be connected but aren't.
  // High text similarity between communities + low edge count = bridge opportunity.

  findSemanticBridges(limit = 10) {
    try {
    const communities = this.kg.communities();
    const communityList = [...communities.entries()]
      .filter(([, members]) => members.length >= 3)
      .map(([label, members]) => ({ label, members }));

    if (communityList.length < 2) return [];

    // Build TF-IDF
    const { vectors: tfidfVectors } = this.kg._buildTFIDF();

    // For each community, compute a summary: top tags, sample titles
    const communityProfiles = communityList.map(c => {
      const tagCounts = new Map();
      const titles = [];
      for (const id of c.members) {
        const node = this.kg.getNode(id);
        if (!node) continue;
        if (node.title) titles.push(node.title);
        for (const tag of (node.metadata?.tags || [])) {
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        }
      }
      const topTags = [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([tag]) => tag);

      return {
        label: c.label,
        members: c.members,
        size: c.members.length,
        topTags,
        sampleTitles: titles.slice(0, 3)
      };
    });

    // Compare pairs of communities (sample if too many)
    const maxPairs = 100;
    const results = [];
    let pairsChecked = 0;

    for (let i = 0; i < communityProfiles.length && pairsChecked < maxPairs; i++) {
      for (let j = i + 1; j < communityProfiles.length && pairsChecked < maxPairs; j++) {
        pairsChecked++;

        const cA = communityProfiles[i];
        const cB = communityProfiles[j];

        // Sample members for similarity computation (cap at 15 per community)
        const sampleA = cA.members.slice(0, 15);
        const sampleB = cB.members.slice(0, 15);

        // Average TF-IDF similarity between the two communities
        let totalSim = 0;
        let simCount = 0;
        const topPairs = []; // track best individual pairs for suggestions

        for (const idA of sampleA) {
          const vecA = tfidfVectors.get(idA);
          if (!vecA) continue;
          for (const idB of sampleB) {
            const vecB = tfidfVectors.get(idB);
            if (!vecB) continue;
            const sim = this.kg.cosineSimilarity(vecA, vecB);
            totalSim += sim;
            simCount++;
            if (sim > 0.1) {
              topPairs.push({ from: idA, to: idB, similarity: sim });
            }
          }
        }

        const avgSimilarity = simCount > 0 ? totalSim / simCount : 0;
        if (avgSimilarity < 0.05) continue;

        // Count actual edges between the two communities
        const memberSetB = new Set(cB.members);
        let existingEdges = 0;
        for (const idA of cA.members) {
          const outEdges = this.kg.adjacency.get(idA) || new Set();
          for (const eid of outEdges) {
            const edge = this.kg.getEdge(eid);
            if (edge && memberSetB.has(edge.to)) existingEdges++;
          }
          const inEdges = this.kg.reverseAdj.get(idA) || new Set();
          for (const eid of inEdges) {
            const edge = this.kg.getEdge(eid);
            if (edge && memberSetB.has(edge.from)) existingEdges++;
          }
        }

        // Bridge potential: high similarity, low edges
        const edgeDensity = (cA.size * cB.size) > 0
          ? existingEdges / Math.min(cA.size, cB.size)
          : 0;
        const bridgePotential = avgSimilarity * (1 - Math.min(1, edgeDensity));

        if (bridgePotential < 0.02) continue;

        // Top suggested connections
        const suggestedConnections = topPairs
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 3)
          .map(p => ({
            from: { id: p.from, title: this.kg.getNode(p.from)?.title || p.from },
            to: { id: p.to, title: this.kg.getNode(p.to)?.title || p.to },
            similarity: Math.round(p.similarity * 1000) / 1000
          }));

        results.push({
          communityA: { size: cA.size, topTags: cA.topTags, sampleTitles: cA.sampleTitles },
          communityB: { size: cB.size, topTags: cB.topTags, sampleTitles: cB.sampleTitles },
          similarity: Math.round(avgSimilarity * 1000) / 1000,
          existingEdges,
          bridgePotential: Math.round(bridgePotential * 1000) / 1000,
          suggestedConnections
        });
      }
    }

    // Dedup: filter out bridge pairs seen in the last 7 days
    const now = Date.now();
    let bridgesFiltered = 0;
    const dedupedResults = results.filter(bridge => {
      const fp = this._bridgeFingerprint(bridge.communityA, bridge.communityB);
      const lastSeen = this.cache.bridges[fp];
      if (lastSeen && (now - lastSeen) < CACHE_MAX_AGE) {
        bridgesFiltered++;
        return false;
      }
      this.cache.bridges[fp] = now;
      return true;
    });

    this._lastBridgesFiltered = bridgesFiltered;

    return dedupedResults
      .sort((a, b) => b.bridgePotential - a.bridgePotential)
      .slice(0, limit);
    } catch (err) {
      console.error(`[Associator] findSemanticBridges failed: ${err.message}`);
      return [];
    }
  }

  // ── Full Analysis ─────────────────────────────────────────────
  // Run all four methods and return a combined report.

  analyze() {
    const t0 = Date.now();

    // Reset per-run dedup counters
    this._lastConceptsFiltered = 0;
    this._lastLinksFiltered = 0;
    this._lastBridgesFiltered = 0;

    const analogies = this.structuralAnalogies(10);
    const predictedLinks = this.predictLinks(20);
    const emergentConcepts = this.extractEmergentConcepts(3, 0.25);
    const semanticBridges = this.findSemanticBridges(10);

    // Persist the cache after a full analysis run
    this._saveCache();

    const elapsed = Date.now() - t0;

    return {
      analogies,
      predictedLinks,
      emergentConcepts,
      semanticBridges,
      dedup: {
        conceptsFiltered: this._lastConceptsFiltered,
        linksFiltered: this._lastLinksFiltered,
        bridgesFiltered: this._lastBridgesFiltered
      },
      summary: {
        analogiesFound: analogies.length,
        linksPredictor: predictedLinks.length,
        emergentConceptsFound: emergentConcepts.length,
        semanticBridgesFound: semanticBridges.length,
        totalFindings: analogies.length + predictedLinks.length + emergentConcepts.length + semanticBridges.length,
        elapsedMs: elapsed
      },
      timestamp: Date.now()
    };
  }

  // ── Self-Report ───────────────────────────────────────────────

  selfReport() {
    const nodeCount = this.kg.nodes.size;
    const edgeCount = this.kg.edges.size;

    return {
      capabilities: [
        'structural-analogies',
        'missing-link-prediction',
        'emergent-concept-extraction',
        'semantic-bridge-discovery'
      ],
      description: 'Discovers emergent connections across the knowledge graph that no one explicitly created. Finds what the graph knows but hasn\'t noticed.',
      graphSize: {
        nodes: nodeCount,
        edges: edgeCount
      }
    };
  }

  // ── Private Helpers ───────────────────────────────────────────

  _cosineSimilarityArrays(a, b) {
    if (a.length !== b.length) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
  }
}

module.exports = Associator;
