// ============================================================
// SOMA — Intake Buffer
// The space between raw sensor output and the knowledge graph.
// Items land here, get scored for relevance against existing
// knowledge, and wait for promotion or discard.
//
// This prevents low-quality data from polluting the KG while
// ensuring high-relevance items get integrated.
// ============================================================

const fs = require('fs').promises;
const path = require('path');

let _config = {};
try { _config = require('../../soma.config.js'); } catch (_) {}
const DATA_DIR = process.env.SOMA_DATA || _config.dataDir || path.join(__dirname, '../../data');
const DEFAULT_BUFFER_FILE = path.join(DATA_DIR, 'intake_buffer.json');

class IntakeBuffer {
  constructor(knowledgeGraph, options = {}) {
    this.kg = knowledgeGraph;
    this.bufferFile = options.bufferFile || DEFAULT_BUFFER_FILE;
    this.items = [];
    this.seenIds = new Set();
  }

  // ── Persistence ────────────────────────────────────────────

  async load() {
    try {
      const raw = await fs.readFile(this.bufferFile, 'utf8');
      const data = JSON.parse(raw);
      this.items = Array.isArray(data.items) ? data.items : [];
      this.seenIds = new Set(this.items.map(i => i.id));
    } catch (err) {
      if (err.code === 'ENOENT') {
        // First run — no buffer file yet
        this.items = [];
        this.seenIds = new Set();
      } else {
        console.error(`[IntakeBuffer] Load error: ${err.message}`);
        this.items = [];
        this.seenIds = new Set();
      }
    }
  }

  async save() {
    try {
      const data = {
        lastSaved: Date.now(),
        count: this.items.length,
        items: this.items
      };
      await fs.writeFile(this.bufferFile, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`[IntakeBuffer] Save error: ${err.message}`);
    }
  }

  // ── Relevance Scoring ──────────────────────────────────────
  // Score an intake item against the knowledge graph.
  // Higher score = more connected to existing knowledge.

  scoreRelevance(item) {
    const searchTerms = [];

    // Build a combined text from all available fields
    if (item.title) searchTerms.push(item.title);
    if (item.abstract) searchTerms.push(item.abstract.slice(0, 500)); // Cap abstract length for perf
    if (item.meshTerms) searchTerms.push(...item.meshTerms);
    if (item.keywords) searchTerms.push(...item.keywords);

    const queryText = searchTerms.join(' ');
    if (!queryText.trim()) {
      return { score: 0, matchedNodes: [] };
    }

    // 1. Text similarity search against the KG
    const textMatches = this.kg.searchByText(queryText, 20);

    // 2. Tag-based matching — check if any mesh terms or keywords
    //    match existing tags in the KG
    const tagMatches = new Set();
    const allTerms = [...(item.meshTerms || []), ...(item.keywords || [])];
    for (const term of allTerms) {
      const normalized = term.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      if (this.kg.byTag.has(normalized)) {
        for (const nodeId of this.kg.byTag.get(normalized)) {
          tagMatches.add(nodeId);
        }
      }
      // Also try the raw term
      if (this.kg.byTag.has(term.toLowerCase())) {
        for (const nodeId of this.kg.byTag.get(term.toLowerCase())) {
          tagMatches.add(nodeId);
        }
      }
    }

    // 3. Combine: text similarity scores + tag match bonus
    const matchedNodes = [];
    const nodeScores = new Map();

    // Score from text search
    for (const match of textMatches) {
      const nodeId = match.id;
      const sim = match.relevance || 0;
      nodeScores.set(nodeId, (nodeScores.get(nodeId) || 0) + sim);
    }

    // Bonus for tag matches
    for (const nodeId of tagMatches) {
      nodeScores.set(nodeId, (nodeScores.get(nodeId) || 0) + 0.15);
    }

    // Build matched nodes list, sorted by combined score
    for (const [nodeId, score] of nodeScores) {
      const node = this.kg.getNode(nodeId);
      if (node) {
        matchedNodes.push({
          id: nodeId,
          title: node.title || node.id,
          similarity: Math.min(1, score)  // Cap at 1.0
        });
      }
    }

    matchedNodes.sort((a, b) => b.similarity - a.similarity);

    // Final score: weighted combination of match count and average similarity
    const topMatches = matchedNodes.slice(0, 10);
    if (topMatches.length === 0) {
      return { score: 0, matchedNodes: [] };
    }

    const avgSim = topMatches.reduce((s, m) => s + m.similarity, 0) / topMatches.length;
    // Score scales with both connection depth and strength
    const score = Math.min(1, avgSim * Math.log2(topMatches.length + 1));

    return {
      score: Math.round(score * 1000) / 1000, // 3 decimal places
      matchedNodes: topMatches
    };
  }

  // ── Ingestion ──────────────────────────────────────────────
  // Add items from a sensor, score them, store in buffer.

  async ingest(sensorName, items) {
    const results = [];

    for (const item of items) {
      const id = `${sensorName}:${item.pmid || item.id || Date.now()}`;
      if (this.seenIds.has(id)) continue;

      const relevance = this.scoreRelevance(item);

      const record = {
        id,
        source: sensorName,
        ingestedAt: Date.now(),
        status: 'new',             // new | reviewed | promoted | discarded
        relevanceScore: relevance.score,
        matchedNodes: relevance.matchedNodes.slice(0, 5), // Keep top 5 for storage
        data: item
      };

      this.items.push(record);
      this.seenIds.add(id);
      results.push(record);
    }

    await this.save();
    return results;
  }

  // ── Retrieval ──────────────────────────────────────────────

  // Get items above a relevance threshold that haven't been acted on
  getActionable(minScore = 0.1) {
    return this.items
      .filter(i => i.status === 'new' && i.relevanceScore >= minScore)
      .sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  // Get items by status
  getByStatus(status) {
    return this.items.filter(i => i.status === status);
  }

  // Get a specific item
  getItem(itemId) {
    return this.items.find(i => i.id === itemId) || null;
  }

  // ── Promotion & Discard ────────────────────────────────────

  // Promote an intake item to the knowledge graph
  async promote(itemId) {
    const item = this.items.find(i => i.id === itemId);
    if (!item) {
      console.log(`[IntakeBuffer] Promote failed: item "${itemId}" not found`);
      return null;
    }
    if (item.status === 'promoted') {
      console.log(`[IntakeBuffer] Promote skipped: item "${itemId}" already promoted`);
      return null;
    }

    const data = item.data;

    // Create a node in the KG
    const nodeId = `sensor-${item.source}-${data.pmid || Date.now()}`;
    const node = this.kg.addNode({
      id: nodeId,
      type: 'literature',
      title: data.title || 'Untitled article',
      body: data.abstract || '',
      content: [data.title, data.abstract].filter(Boolean).join('\n\n'),
      metadata: {
        confidence: Math.min(0.9, item.relevanceScore + 0.3),
        maturity: 'seed',
        tags: [
          'literature',
          `sensor-${item.source}`,
          data.query || 'unknown',
          ...(data.meshTerms || []).slice(0, 5).map(t => t.toLowerCase()),
          ...(data.keywords || []).slice(0, 3).map(k => k.toLowerCase())
        ],
        source: `sensor:${item.source}`,
        pmid: data.pmid,
        doi: data.doi,
        journal: data.journal,
        pubDate: data.pubDate,
        authors: (data.authors || []).map(a => a.name).join(', '),
        promotedAt: Date.now()
      }
    });

    // Connect to matched nodes in the KG
    for (const matched of (item.matchedNodes || []).slice(0, 3)) {
      if (this.kg.getNode(matched.id)) {
        this.kg.addEdge(nodeId, matched.id, 'relates-to', matched.similarity, {
          source: 'sensor-promotion',
          reason: 'relevance match during intake'
        });
      }
    }

    item.status = 'promoted';
    item.promotedAt = Date.now();
    item.promotedNodeId = nodeId;
    await this.save();

    const matchCount = (item.matchedNodes || []).length;
    console.log(`[IntakeBuffer] Promoted "${(data.title || itemId).slice(0, 60)}" -> ${nodeId} (${matchCount} KG connections)`);

    return item;
  }

  // Mark as discarded (not relevant enough)
  async discard(itemId) {
    const item = this.items.find(i => i.id === itemId);
    if (!item) return null;

    item.status = 'discarded';
    item.discardedAt = Date.now();
    await this.save();

    console.log(`[IntakeBuffer] Discarded "${(item.data?.title || itemId).slice(0, 60)}" (relevance: ${(item.relevanceScore || 0).toFixed(3)})`);

    return item;
  }

  // ── Maintenance ────────────────────────────────────────────

  // Prune old discarded items to keep buffer manageable
  async prune(maxAge = 30 * 24 * 60 * 60 * 1000) { // 30 days default
    const cutoff = Date.now() - maxAge;
    const before = this.items.length;

    this.items = this.items.filter(i => {
      // Keep all non-discarded items
      if (i.status !== 'discarded') return true;
      // Keep recent discards
      return (i.discardedAt || i.ingestedAt) > cutoff;
    });

    // Rebuild seenIds from remaining items
    this.seenIds = new Set(this.items.map(i => i.id));

    if (this.items.length < before) {
      await this.save();
      return before - this.items.length;
    }
    return 0;
  }

  // ── Stats ──────────────────────────────────────────────────

  summary() {
    const statusCounts = { new: 0, reviewed: 0, promoted: 0, discarded: 0 };
    let totalRelevance = 0;

    for (const item of this.items) {
      statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;
      totalRelevance += item.relevanceScore || 0;
    }

    return {
      total: this.items.length,
      ...statusCounts,
      avgRelevance: this.items.length
        ? Math.round((totalRelevance / this.items.length) * 1000) / 1000
        : 0,
      topItem: this.items.length
        ? this.items.reduce((best, i) => i.relevanceScore > (best?.relevanceScore || 0) ? i : best, null)?.data?.title || null
        : null
    };
  }
}

module.exports = IntakeBuffer;
