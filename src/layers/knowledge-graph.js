// ============================================================
// CORTEX CORE — Knowledge Graph
// The foundation. Everything else reasons over this.
// ============================================================

class KnowledgeGraph {
  constructor() {
    this.nodes = new Map();           // id -> node
    this.edges = new Map();           // edgeId -> edge
    this.adjacency = new Map();       // nodeId -> Set<edgeId> (outgoing)
    this.reverseAdj = new Map();      // nodeId -> Set<edgeId> (incoming)

    // Indexes for fast lookup
    this.byType = new Map();          // type -> Set<nodeId>
    this.byTag = new Map();           // tag -> Set<nodeId>
    this.bySource = new Map();        // source -> Set<nodeId>

    // TF-IDF state (rebuilt on demand)
    this._tfidfDirty = true;
    this._tfidf = null;               // { idf: Map<term, score>, vectors: Map<nodeId, Map<term, tfidf>> }

    // Stats
    this.stats = {
      nodesAdded: 0,
      edgesAdded: 0,
      queries: 0,
      traversals: 0,
      lastModified: null
    };
  }

  // ── Node Operations ─────────────────────────────────────────

  addNode(node) {
    if (!node.id) node.id = `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    if (!node.metadata) node.metadata = {};
    node.metadata.created = node.metadata.created || Date.now();
    node.metadata.updated = Date.now();
    node.metadata.confidence = node.metadata.confidence ?? 1.0;
    node.metadata.tags = node.metadata.tags || [];
    node.metadata.maturity = node.metadata.maturity || 'seed';

    // Auto-extract tags when none were provided
    if (node.metadata.tags.length === 0) {
      node.metadata.tags = this._autoExtractTags(node);
    }

    this.nodes.set(node.id, node);
    if (!this.adjacency.has(node.id)) this.adjacency.set(node.id, new Set());
    if (!this.reverseAdj.has(node.id)) this.reverseAdj.set(node.id, new Set());

    // Index by type
    if (node.type) {
      if (!this.byType.has(node.type)) this.byType.set(node.type, new Set());
      this.byType.get(node.type).add(node.id);
    }

    // Index by tags
    for (const tag of (node.metadata.tags || [])) {
      if (!this.byTag.has(tag)) this.byTag.set(tag, new Set());
      this.byTag.get(tag).add(node.id);
    }

    // Index by source
    if (node.metadata.source) {
      if (!this.bySource.has(node.metadata.source)) this.bySource.set(node.metadata.source, new Set());
      this.bySource.get(node.metadata.source).add(node.id);
    }

    this._tfidfDirty = true;
    this.stats.nodesAdded++;
    this.stats.lastModified = Date.now();
    return node;
  }

  getNode(id) {
    return this.nodes.get(id) || null;
  }

  updateNode(id, updates) {
    const node = this.nodes.get(id);
    if (!node) return null;

    // Remove old tag indexes
    for (const tag of (node.metadata.tags || [])) {
      const tagSet = this.byTag.get(tag);
      if (tagSet) tagSet.delete(id);
    }

    // Apply updates
    if (updates.id) delete updates.id; // Prevent ID corruption
    Object.assign(node, updates);
    if (updates.metadata) Object.assign(node.metadata, updates.metadata);
    node.metadata.updated = Date.now();

    // Rebuild tag indexes
    for (const tag of (node.metadata.tags || [])) {
      if (!this.byTag.has(tag)) this.byTag.set(tag, new Set());
      this.byTag.get(tag).add(id);
    }

    this._tfidfDirty = true;
    this.stats.lastModified = Date.now();
    return node;
  }

  removeNode(id) {
    const node = this.nodes.get(id);
    if (!node) return false;

    // Remove all edges involving this node
    const outgoing = this.adjacency.get(id) || new Set();
    const incoming = this.reverseAdj.get(id) || new Set();
    for (const edgeId of [...outgoing, ...incoming]) {
      this._removeEdge(edgeId);
    }

    // Remove from indexes
    if (node.type) {
      const typeSet = this.byType.get(node.type);
      if (typeSet) typeSet.delete(id);
    }
    for (const tag of (node.metadata.tags || [])) {
      const tagSet = this.byTag.get(tag);
      if (tagSet) tagSet.delete(id);
    }
    if (node.metadata.source) {
      const srcSet = this.bySource.get(node.metadata.source);
      if (srcSet) srcSet.delete(id);
    }

    this.nodes.delete(id);
    this.adjacency.delete(id);
    this.reverseAdj.delete(id);
    this._tfidfDirty = true;
    this.stats.lastModified = Date.now();
    return true;
  }

  // ── Edge Operations ─────────────────────────────────────────

  addEdge(from, to, type = 'relates-to', weight = 1.0, metadata = {}) {
    if (!this.nodes.has(from) || !this.nodes.has(to)) return null;

    const id = `e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const edge = {
      id,
      from,
      to,
      type,       // supports, contradicts, evolves-from, synthesizes, relates-to, depends-on
      weight,     // 0-1
      metadata: { ...metadata, created: Date.now() }
    };

    this.edges.set(id, edge);
    this.adjacency.get(from).add(id);
    this.reverseAdj.get(to).add(id);

    this.stats.edgesAdded++;
    this.stats.lastModified = Date.now();
    return edge;
  }

  getEdge(id) {
    return this.edges.get(id) || null;
  }

  getEdgesBetween(fromId, toId) {
    const outgoing = this.adjacency.get(fromId) || new Set();
    return [...outgoing]
      .map(eid => this.edges.get(eid))
      .filter(e => e && e.to === toId);
  }

  _removeEdge(edgeId) {
    const edge = this.edges.get(edgeId);
    if (!edge) return;
    const outSet = this.adjacency.get(edge.from);
    if (outSet) outSet.delete(edgeId);
    const inSet = this.reverseAdj.get(edge.to);
    if (inSet) inSet.delete(edgeId);
    this.edges.delete(edgeId);
  }

  // ── Query ───────────────────────────────────────────────────

  query(filter = {}) {
    this.stats.queries++;
    let candidates;

    // Start from index if possible
    if (filter.type && this.byType.has(filter.type)) {
      candidates = [...this.byType.get(filter.type)];
    } else if (filter.tag && this.byTag.has(filter.tag)) {
      candidates = [...this.byTag.get(filter.tag)];
    } else {
      candidates = [...this.nodes.keys()];
      if (candidates.length > 1000) candidates = candidates.slice(0, 1000); // Don't scan entire graph for unindexed queries
    }

    return candidates
      .map(id => this.nodes.get(id))
      .filter(node => {
        if (!node) return false;
        if (filter.type && node.type !== filter.type) return false;
        if (filter.tag && !(node.metadata.tags || []).includes(filter.tag)) return false;
        if (filter.tags && !filter.tags.every(t => (node.metadata.tags || []).includes(t))) return false;
        if (filter.minConfidence && (node.metadata.confidence || 0) < filter.minConfidence) return false;
        if (filter.maturity && node.metadata.maturity !== filter.maturity) return false;
        if (filter.source && node.metadata.source !== filter.source) return false;
        if (filter.since && (node.metadata.created || 0) < filter.since) return false;
        if (filter.text) {
          const text = `${node.title || ''} ${node.body || ''} ${node.content || ''}`.toLowerCase();
          if (!text.includes(filter.text.toLowerCase())) return false;
        }
        return true;
      });
  }

  // ── Traversal ───────────────────────────────────────────────

  neighbors(nodeId, direction = 'both') {
    const results = [];

    if (direction === 'outgoing' || direction === 'both') {
      const outEdges = this.adjacency.get(nodeId) || new Set();
      for (const eid of outEdges) {
        const edge = this.edges.get(eid);
        if (edge) results.push({ node: this.nodes.get(edge.to), edge, direction: 'outgoing' });
      }
    }

    if (direction === 'incoming' || direction === 'both') {
      const inEdges = this.reverseAdj.get(nodeId) || new Set();
      for (const eid of inEdges) {
        const edge = this.edges.get(eid);
        if (edge) results.push({ node: this.nodes.get(edge.from), edge, direction: 'incoming' });
      }
    }

    return results.filter(r => r.node);
  }

  traverse(startId, maxDepth = 3, filter = {}) {
    this.stats.traversals++;
    const visited = new Set();
    const result = [];
    const queue = [{ id: startId, depth: 0, path: [] }];

    while (queue.length > 0) {
      if (queue.length > 10000) break; // Safety valve — prevent OOM on dense graphs
      const { id, depth, path } = queue.shift();
      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);

      const node = this.nodes.get(id);
      if (!node) continue;

      // Apply filter
      if (filter.type && node.type !== filter.type) continue;
      if (filter.minWeight !== undefined) {
        // Check the edge that brought us here
        const lastEdge = path[path.length - 1];
        if (lastEdge && lastEdge.weight < filter.minWeight) continue;
      }

      result.push({ node, depth, path: [...path] });

      // Expand neighbors
      const nbrs = this.neighbors(id, filter.direction || 'both');
      for (const { node: nbr, edge } of nbrs) {
        if (!visited.has(nbr.id)) {
          queue.push({
            id: nbr.id,
            depth: depth + 1,
            path: [...path, edge]
          });
        }
      }
    }

    return result;
  }

  findPaths(fromId, toId, maxDepth = 5) {
    const paths = [];
    const dfs = (current, target, visited, path) => {
      if (paths.length >= 100) return; // Cap results to prevent stack overflow
      if (current === target) {
        paths.push([...path]);
        return;
      }
      if (path.length >= maxDepth) return;

      const outEdges = this.adjacency.get(current) || new Set();
      for (const eid of outEdges) {
        const edge = this.edges.get(eid);
        if (edge && !visited.has(edge.to)) {
          visited.add(edge.to);
          path.push(edge);
          dfs(edge.to, target, visited, path);
          path.pop();
          visited.delete(edge.to);
        }
      }
    };

    const visited = new Set([fromId]);
    dfs(fromId, toId, visited, []);
    return paths;
  }

  // ── Analysis ────────────────────────────────────────────────

  pageRank(iterations = 20, damping = 0.85) {
    const n = this.nodes.size;
    if (n === 0) return new Map();

    const scores = new Map();
    const ids = [...this.nodes.keys()];

    // Initialize
    for (const id of ids) scores.set(id, 1 / n);

    for (let i = 0; i < iterations; i++) {
      const newScores = new Map();
      for (const id of ids) {
        let inScore = 0;
        const incoming = this.reverseAdj.get(id) || new Set();
        for (const eid of incoming) {
          const edge = this.edges.get(eid);
          if (edge) {
            const outDegree = (this.adjacency.get(edge.from) || new Set()).size;
            if (outDegree > 0) {
              inScore += (scores.get(edge.from) || 0) * edge.weight / outDegree;
            }
          }
        }
        newScores.set(id, (1 - damping) / n + damping * inScore);
      }
      for (const [id, score] of newScores) scores.set(id, score);
    }

    return scores;
  }

  communities(maxIterations = 10) {
    // Label propagation
    const labels = new Map();
    const ids = [...this.nodes.keys()];
    for (const id of ids) labels.set(id, id);

    for (let i = 0; i < maxIterations; i++) {
      let changed = false;
      // Shuffle for randomness
      const shuffled = ids.slice().sort(() => Math.random() - 0.5);

      for (const id of shuffled) {
        const nbrs = this.neighbors(id, 'both');
        if (nbrs.length === 0) continue;

        // Count neighbor labels weighted by edge weight
        const labelCounts = new Map();
        for (const { edge } of nbrs) {
          const nbrId = edge.from === id ? edge.to : edge.from;
          const label = labels.get(nbrId);
          labelCounts.set(label, (labelCounts.get(label) || 0) + (edge.weight || 1));
        }

        // Pick most frequent label
        let bestLabel = labels.get(id);
        let bestCount = 0;
        for (const [label, count] of labelCounts) {
          if (count > bestCount) {
            bestCount = count;
            bestLabel = label;
          }
        }

        if (bestLabel !== labels.get(id)) {
          labels.set(id, bestLabel);
          changed = true;
        }
      }

      if (!changed) break;
    }

    // Group by label
    const communities = new Map();
    for (const [id, label] of labels) {
      if (!communities.has(label)) communities.set(label, []);
      communities.get(label).push(id);
    }

    return communities;
  }

  orphans() {
    return [...this.nodes.keys()].filter(id => {
      const out = (this.adjacency.get(id) || new Set()).size;
      const inc = (this.reverseAdj.get(id) || new Set()).size;
      return out === 0 && inc === 0;
    });
  }

  bridgeNodes() {
    // Simplified betweenness: nodes that appear on many shortest paths
    const ids = [...this.nodes.keys()];
    const counts = new Map();
    for (const id of ids) counts.set(id, 0);

    // Sample pairs to keep it tractable
    const sampleSize = Math.min(ids.length, 50);
    const sampled = ids.slice().sort(() => Math.random() - 0.5).slice(0, sampleSize);

    for (let i = 0; i < sampled.length; i++) {
      for (let j = i + 1; j < sampled.length; j++) {
        const paths = this.findPaths(sampled[i], sampled[j], 4);
        for (const path of paths) {
          for (const edge of path) {
            // Both endpoints of each edge are on the path
            counts.set(edge.from, (counts.get(edge.from) || 0) + 1);
            counts.set(edge.to, (counts.get(edge.to) || 0) + 1);
          }
        }
      }
    }

    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([id, score]) => ({ id, score, node: this.nodes.get(id) }));
  }

  // ── Auto Tag Extraction ──────────────────────────────────────
  // Extracts 2-8 meaningful tags from a node's title and body when
  // the caller didn't provide any. Uses domain term matching + title
  // word extraction, matching the enrichment script's approach.

  _autoExtractTags(node) {
    const title = node.title || '';
    const body = node.body || node.content || '';
    const text = `${title} ${body}`.toLowerCase();
    const tags = new Set();

    // 1. Domain term matching — known project/topic keywords get priority
    //    Use word-boundary regex for short terms to avoid false positives
    //    (e.g. "gene" matching inside "generation")
    for (const [term, tag] of DOMAIN_TERMS) {
      if (term.length <= 5) {
        // Short terms need word boundaries
        const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        if (re.test(text)) tags.add(tag);
      } else {
        if (text.includes(term)) tags.add(tag);
      }
    }

    // 2. Extract meaningful words from title (higher signal than body)
    const titleWords = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w) &&
        !w.match(/^\d+$/) && !w.match(/^https?/) &&
        !w.match(/^[0-9a-f]{10,}$/) && w.length <= 25);

    for (const word of titleWords) {
      tags.add(word);
    }

    // 3. If still thin, pull high-frequency words from body
    if (tags.size < 2 && body) {
      const bodyWords = body
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 5 && !STOP_WORDS.has(w) &&
          !w.match(/^\d+$/) && w.length <= 25);

      const freq = {};
      for (const w of bodyWords) freq[w] = (freq[w] || 0) + 1;

      const topBody = Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([w]) => w);

      for (const w of topBody) tags.add(w);
    }

    // 4. If no text at all, derive from ID
    if (tags.size === 0 && node.id) {
      if (node.id.includes('pubmed')) { tags.add('literature'); tags.add('research'); }
      if (node.id.includes('rss')) { tags.add('rss-feed'); tags.add('research'); }
      if (node.id.includes('meta-quest') || node.id.includes('quest')) tags.add('quest');
      if (node.id.includes('road-to-vr') || node.id.includes('upload-vr')) tags.add('vr');
      if (node.type) tags.add(node.type);
    }

    // Cap at 8 — domain terms first, then others
    const domainValues = new Set(DOMAIN_TERMS.values());
    const domainTags = [...tags].filter(t => domainValues.has(t));
    const otherTags = [...tags].filter(t => !domainValues.has(t));
    return [...new Set([...domainTags, ...otherTags])].slice(0, 8);
  }

  // ── Text Similarity (TF-IDF) ────────────────────────────────

  _tokenize(text) {
    return (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  }

  _buildTFIDF() {
    if (!this._tfidfDirty && this._tfidf) return this._tfidf;

    const docCount = this.nodes.size;
    const df = new Map();        // term -> number of docs containing it
    const tfVectors = new Map(); // nodeId -> Map<term, tf>

    // Calculate TF and DF
    for (const [id, node] of this.nodes) {
      const text = `${node.title || ''} ${node.body || ''} ${node.content || ''}`;
      const tokens = this._tokenize(text);
      const tf = new Map();
      const seen = new Set();

      for (const token of tokens) {
        tf.set(token, (tf.get(token) || 0) + 1);
        if (!seen.has(token)) {
          df.set(token, (df.get(token) || 0) + 1);
          seen.add(token);
        }
      }

      // Normalize TF
      const maxTf = Math.max(...tf.values(), 1);
      for (const [term, count] of tf) {
        tf.set(term, count / maxTf);
      }

      tfVectors.set(id, tf);
    }

    // Calculate IDF
    const idf = new Map();
    for (const [term, count] of df) {
      idf.set(term, Math.log(docCount / (1 + count)));
    }

    // Build TF-IDF vectors
    const tfidfVectors = new Map();
    for (const [id, tf] of tfVectors) {
      const vec = new Map();
      for (const [term, tfScore] of tf) {
        vec.set(term, tfScore * (idf.get(term) || 0));
      }
      tfidfVectors.set(id, vec);
    }

    this._tfidf = { idf, vectors: tfidfVectors };
    this._tfidfDirty = false;
    return this._tfidf;
  }

  cosineSimilarity(vecA, vecB) {
    let dot = 0, magA = 0, magB = 0;
    for (const [term, a] of vecA) {
      const b = vecB.get(term) || 0;
      dot += a * b;
      magA += a * a;
    }
    for (const [, b] of vecB) {
      magB += b * b;
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
  }

  findSimilar(nodeId, threshold = 0.1, limit = 10) {
    const { vectors } = this._buildTFIDF();
    const sourceVec = vectors.get(nodeId);
    if (!sourceVec) return [];

    const results = [];
    for (const [id, vec] of vectors) {
      if (id === nodeId) continue;
      const sim = this.cosineSimilarity(sourceVec, vec);
      if (sim >= threshold) {
        results.push({ id, node: this.nodes.get(id), similarity: sim });
      }
    }

    return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  searchByText(queryText, limit = 10) {
    const { idf, vectors } = this._buildTFIDF();
    const queryTokens = this._tokenize(queryText);

    // Build query vector
    const queryVec = new Map();
    for (const token of queryTokens) {
      queryVec.set(token, (queryVec.get(token) || 0) + 1);
    }
    const maxTf = Math.max(...queryVec.values(), 1);
    for (const [term, count] of queryVec) {
      queryVec.set(term, (count / maxTf) * (idf.get(term) || 0));
    }

    const results = [];
    for (const [id, vec] of vectors) {
      const sim = this.cosineSimilarity(queryVec, vec);
      if (sim > 0) {
        results.push({ id, node: this.nodes.get(id), relevance: sim });
      }
    }

    return results.sort((a, b) => b.relevance - a.relevance).slice(0, limit);
  }

  // Compare two nodes by text similarity (title + body TF-IDF cosine)
  textSimilarity(nodeIdA, nodeIdB) {
    const a = this.nodes.get(nodeIdA);
    const b = this.nodes.get(nodeIdB);
    if (!a || !b) return 0;
    const textA = `${a.title || ''} ${a.body || ''} ${(a.tags || []).join(' ')}`;
    const textB = `${b.title || ''} ${b.body || ''} ${(b.tags || []).join(' ')}`;
    const tokensA = this._tokenize(textA);
    const tokensB = this._tokenize(textB);
    if (tokensA.length === 0 || tokensB.length === 0) return 0;
    // Build simple TF vectors and compute cosine
    const vecA = new Map(), vecB = new Map();
    for (const t of tokensA) vecA.set(t, (vecA.get(t) || 0) + 1);
    for (const t of tokensB) vecB.set(t, (vecB.get(t) || 0) + 1);
    return this.cosineSimilarity(vecA, vecB);
  }

  // ── Import from Thoughtstream ───────────────────────────────

  importThoughtstream(thoughts) {
    let imported = 0;
    for (const t of thoughts) {
      this.addNode({
        id: t.id,
        type: t.type || 'thought',
        title: t.title,
        body: t.body,
        content: t.body,
        metadata: {
          created: t.created,
          updated: t.updated || t.created,
          confidence: t.confidence ?? 1.0,
          maturity: t.maturity || 'seed',
          tags: t.tags || [],
          source: 'thoughtstream',
          updates: t.updates || [],
          lineage: t.lineage || {}
        }
      });
      imported++;
    }

    // Second pass: import connections
    for (const t of thoughts) {
      for (const conn of (t.connections || [])) {
        if (this.nodes.has(t.id) && this.nodes.has(conn.targetId)) {
          this.addEdge(t.id, conn.targetId, conn.type || 'relates-to', conn.weight || 1.0, {
            note: conn.note
          });
        }
      }
    }

    return imported;
  }

  // ── Persistence ─────────────────────────────────────────────

  serialize() {
    return {
      nodes: [...this.nodes.entries()].map(([id, node]) => ({ ...node })),
      edges: [...this.edges.entries()].map(([id, edge]) => ({ ...edge })),
      stats: this.stats,
      exportedAt: Date.now()
    };
  }

  static deserialize(data) {
    const kg = new KnowledgeGraph();
    for (const node of (data.nodes || [])) {
      kg.addNode(node);
    }
    for (const edge of (data.edges || [])) {
      if (kg.nodes.has(edge.from) && kg.nodes.has(edge.to)) {
        const e = kg.addEdge(edge.from, edge.to, edge.type, edge.weight, edge.metadata);
        if (e && edge.id) {
          // Preserve original edge ID
          kg.edges.delete(e.id);
          kg.adjacency.get(edge.from).delete(e.id);
          kg.reverseAdj.get(edge.to).delete(e.id);
          e.id = edge.id;
          kg.edges.set(edge.id, e);
          kg.adjacency.get(edge.from).add(edge.id);
          kg.reverseAdj.get(edge.to).add(edge.id);
        }
      }
    }
    if (data.stats) kg.stats = { ...kg.stats, ...data.stats };
    return kg;
  }

  save(filepath) {
    const fs = require('fs');
    fs.writeFileSync(filepath, JSON.stringify(this.serialize(), null, 2));
  }

  static load(filepath) {
    const fs = require('fs');
    if (!fs.existsSync(filepath)) return new KnowledgeGraph();
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    return KnowledgeGraph.deserialize(data);
  }

  // ── Introspection (Self-Model) ──────────────────────────────

  selfReport() {
    const types = {};
    for (const [type, ids] of this.byType) types[type] = ids.size;

    const maturities = {};
    for (const node of this.nodes.values()) {
      const m = node.metadata?.maturity || 'unknown';
      maturities[m] = (maturities[m] || 0) + 1;
    }

    const orphanCount = this.orphans().length;
    const edgeTypes = {};
    for (const edge of this.edges.values()) {
      edgeTypes[edge.type] = (edgeTypes[edge.type] || 0) + 1;
    }

    return {
      totalNodes: this.nodes.size,
      totalEdges: this.edges.size,
      nodesByType: types,
      nodesByMaturity: maturities,
      edgesByType: edgeTypes,
      orphanCount,
      density: this.nodes.size > 1
        ? (2 * this.edges.size) / (this.nodes.size * (this.nodes.size - 1))
        : 0,
      stats: this.stats
    };
  }
}

// ── Stop Words ──────────────────────────────────────────────
const STOP_WORDS = new Set([
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i',
  'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
  'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her',
  'she', 'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there',
  'their', 'what', 'so', 'up', 'out', 'if', 'about', 'who', 'get',
  'which', 'go', 'me', 'when', 'make', 'can', 'like', 'time', 'no',
  'just', 'him', 'know', 'take', 'people', 'into', 'year', 'your',
  'good', 'some', 'could', 'them', 'see', 'other', 'than', 'then',
  'now', 'look', 'only', 'come', 'its', 'over', 'think', 'also',
  'back', 'after', 'use', 'two', 'how', 'our', 'work', 'first',
  'well', 'way', 'even', 'new', 'want', 'because', 'any', 'these',
  'give', 'day', 'most', 'us', 'was', 'are', 'has', 'been', 'were',
  'did', 'had', 'does', 'is', 'am', 'being', 'been', 'should',
  'more', 'very', 'much', 'too', 'here',
  'each', 'both', 'such', 'through', 'while', 'where', 'before',
  'between', 'under', 'again', 'further', 'once', 'during', 'doing',
  'same', 'need', 'needs', 'without', 'within', 'using', 'used',
  'based', 'still', 'found', 'many', 'show', 'shows', 'shown',
  'rather', 'already', 'actually', 'real', 'really', 'currently',
  'specific', 'directly', 'clear', 'means', 'mean', 'might',
  'every', 'enough', 'across', 'however', 'whether', 'never',
  'three', 'next', 'since', 'right', 'probably', 'things', 'thing',
  'something', 'someone', 'maybe', 'instead', 'those', 'itself',
  'themselves'
]);

// ── Domain Terms (for auto-tag extraction) ─────────────────
// Maps lowercase search terms to canonical tag names.
// Used by _autoExtractTags() to identify project/topic keywords.
// Add your project-specific terms to soma.config.js → domainTerms:
//   domainTerms: { 'my-project': 'my-project', 'myproj': 'my-project' }
const BASE_DOMAIN_TERMS = new Map([
  ['continuity', 'continuity'],
  ['identity', 'identity'],
  ['mission', 'mission'],
  ['soma', 'soma'],
  ['cortex', 'cortex'],
  ['values', 'values'],
  ['thinking', 'thinking'],
  ['research', 'research'],
  ['hypothesis', 'hypothesis'],
  ['pattern', 'pattern'],
  ['anomaly', 'anomaly'],
  ['medical', 'medical'],
  ['biomarker', 'biomarker'],
  ['knowledge graph', 'knowledge-graph'],
  ['knowledge-graph', 'knowledge-graph'],
  ['inference', 'inference'],
  ['reasoner', 'reasoner'],
  ['goal drift', 'goal-drift'],
  ['goal-drift', 'goal-drift'],
  ['self-model', 'self-model'],
  ['associator', 'associator'],
  ['consolidator', 'consolidator'],
  ['pubmed', 'literature'],
  ['autonomous', 'autonomous-thinking'],
  ['sleep', 'sleep'],
  ['clinical', 'clinical'],
  ['symptom', 'symptoms'],
]);

// Merge with config-supplied domain terms
let _extraDomainTerms = {};
try { _extraDomainTerms = require('../../soma.config.js').domainTerms || {}; } catch (_) {}
const DOMAIN_TERMS = new Map([...BASE_DOMAIN_TERMS, ...Object.entries(_extraDomainTerms)]);

module.exports = KnowledgeGraph;
