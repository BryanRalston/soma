// ============================================================
// CORTEX CORE — Pattern Engine
// Statistical pattern detection over the knowledge graph.
// No ML. Pure math: TF-IDF, correlation, trend detection.
// ============================================================

class PatternEngine {
  constructor(knowledgeGraph) {
    this.kg = knowledgeGraph;
    this.detectedPatterns = [];
    this.temporalCache = new Map(); // tag -> [{timestamp, count}]
  }

  // ── Frequency Analysis ──────────────────────────────────────
  // What concepts keep coming up?

  frequencyAnalysis(windowDays = 30) {
    const cutoff = Date.now() - windowDays * 86400000;
    const tagFreq = new Map();
    const typeFreq = new Map();
    const wordFreq = new Map();

    for (const node of this.kg.nodes.values()) {
      if ((node.metadata?.created || 0) < cutoff) continue;

      // Tag frequency
      for (const tag of (node.metadata?.tags || [])) {
        tagFreq.set(tag, (tagFreq.get(tag) || 0) + 1);
      }

      // Type frequency
      if (node.type) {
        typeFreq.set(node.type, (typeFreq.get(node.type) || 0) + 1);
      }

      // Word frequency (top terms after TF-IDF filtering)
      const text = `${node.title || ''} ${node.body || ''}`.toLowerCase();
      const words = text.split(/\s+/).filter(w => w.length > 3);
      for (const word of words) {
        wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
      }
    }

    return {
      tags: this._sortMap(tagFreq, 20),
      types: this._sortMap(typeFreq),
      topTerms: this._sortMap(wordFreq, 30),
      windowDays,
      totalNodes: this.kg.nodes.size
    };
  }

  // ── Temporal Correlation ────────────────────────────────────
  // Do certain tags/concepts appear together in time?

  temporalCorrelation(tagA, tagB, bucketHours = 24) {
    const bucketMs = bucketHours * 3600000;
    const bucketsA = new Map();
    const bucketsB = new Map();

    for (const node of this.kg.nodes.values()) {
      const t = node.metadata?.created || 0;
      const bucket = Math.floor(t / bucketMs);
      const tags = node.metadata?.tags || [];

      if (tags.includes(tagA)) bucketsA.set(bucket, (bucketsA.get(bucket) || 0) + 1);
      if (tags.includes(tagB)) bucketsB.set(bucket, (bucketsB.get(bucket) || 0) + 1);
    }

    // Get all buckets
    const allBuckets = new Set([...bucketsA.keys(), ...bucketsB.keys()]);
    if (allBuckets.size < 3) return { correlation: 0, insufficient: true };

    const seriesA = [];
    const seriesB = [];
    for (const b of [...allBuckets].sort()) {
      seriesA.push(bucketsA.get(b) || 0);
      seriesB.push(bucketsB.get(b) || 0);
    }

    return {
      correlation: this._pearson(seriesA, seriesB),
      dataPoints: allBuckets.size,
      tagA, tagB,
      coOccurrences: [...allBuckets].filter(b => bucketsA.has(b) && bucketsB.has(b)).length
    };
  }

  // ── Trend Detection ─────────────────────────────────────────
  // Is something increasing, decreasing, or stable?

  trendDetection(tag, windowDays = 60, bucketDays = 7) {
    const bucketMs = bucketDays * 86400000;
    const cutoff = Date.now() - windowDays * 86400000;
    const buckets = new Map();

    for (const node of this.kg.nodes.values()) {
      const t = node.metadata?.created || 0;
      if (t < cutoff) continue;
      if (!(node.metadata?.tags || []).includes(tag)) continue;

      const bucket = Math.floor(t / bucketMs);
      buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
    }

    if (buckets.size < 3) return { trend: 'insufficient-data', tag };

    const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
    const values = sorted.map(([, v]) => v);
    const times = sorted.map(([t]) => t);

    // Linear regression
    const regression = this._linearRegression(times, values);

    let trend;
    if (regression.slope > 0.1) trend = 'increasing';
    else if (regression.slope < -0.1) trend = 'decreasing';
    else trend = 'stable';

    return {
      trend,
      slope: regression.slope,
      r2: regression.r2,
      dataPoints: values.length,
      latest: values[values.length - 1],
      average: values.reduce((a, b) => a + b, 0) / values.length,
      tag
    };
  }

  // ── Cluster Analysis ────────────────────────────────────────
  // What groups naturally form?

  clusterByTags(minOverlap = 2) {
    const nodes = [...this.kg.nodes.values()].filter(n => (n.metadata?.tags || []).length > 0);
    const clusters = [];

    // Group by tag overlap
    const processed = new Set();
    for (let i = 0; i < nodes.length; i++) {
      if (processed.has(nodes[i].id)) continue;

      const cluster = [nodes[i]];
      processed.add(nodes[i].id);
      const clusterTags = new Set(nodes[i].metadata.tags);

      for (let j = i + 1; j < nodes.length; j++) {
        if (processed.has(nodes[j].id)) continue;
        const overlap = (nodes[j].metadata?.tags || []).filter(t => clusterTags.has(t));
        if (overlap.length >= minOverlap) {
          cluster.push(nodes[j]);
          processed.add(nodes[j].id);
          for (const t of (nodes[j].metadata?.tags || [])) clusterTags.add(t);
        }
      }

      if (cluster.length > 1) {
        clusters.push({
          size: cluster.length,
          nodes: cluster.map(n => ({ id: n.id, title: n.title })),
          tags: [...clusterTags],
          avgConfidence: cluster.reduce((s, n) => s + (n.metadata?.confidence || 0.5), 0) / cluster.length
        });
      }
    }

    return clusters.sort((a, b) => b.size - a.size);
  }

  // ── Anomaly Detection ───────────────────────────────────────
  // What doesn't fit?

  detectAnomalies() {
    const anomalies = [];
    const communities = this.kg.communities();

    for (const [, memberIds] of communities) {
      if (memberIds.length < 3) continue;

      // Get community tag profile
      const tagProfile = new Map();
      for (const id of memberIds) {
        const node = this.kg.getNode(id);
        for (const tag of (node?.metadata?.tags || [])) {
          tagProfile.set(tag, (tagProfile.get(tag) || 0) + 1);
        }
      }

      // Find members that don't match the profile
      for (const id of memberIds) {
        const node = this.kg.getNode(id);
        if (!node) continue;
        const nodeTags = new Set(node.metadata?.tags || []);

        // What fraction of the community's top tags does this node have?
        const topTags = [...tagProfile.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([tag]) => tag);
        const overlap = topTags.filter(t => nodeTags.has(t)).length;
        const fit = topTags.length > 0 ? overlap / topTags.length : 1;

        if (fit < 0.2 && topTags.length >= 3) {
          anomalies.push({
            nodeId: id,
            title: node.title,
            fitScore: fit,
            communitySize: memberIds.length,
            missingTags: topTags.filter(t => !nodeTags.has(t)),
            reason: 'Low tag overlap with community'
          });
        }
      }
    }

    // Also flag nodes with unusual confidence relative to their neighbors
    for (const [id, node] of this.kg.nodes) {
      const nbrs = this.kg.neighbors(id, 'both');
      if (nbrs.length < 2) continue;

      const nbrConfidences = nbrs.map(n => n.node.metadata?.confidence || 0.5);
      const avgNbrConf = nbrConfidences.reduce((a, b) => a + b, 0) / nbrConfidences.length;
      const nodeConf = node.metadata?.confidence || 0.5;

      if (Math.abs(nodeConf - avgNbrConf) > 0.4) {
        anomalies.push({
          nodeId: id,
          title: node.title,
          nodeConfidence: nodeConf,
          neighborAvgConfidence: avgNbrConf,
          reason: `Confidence outlier (${nodeConf.toFixed(2)} vs neighbors avg ${avgNbrConf.toFixed(2)})`
        });
      }
    }

    return anomalies;
  }

  // ── Cross-Domain Pattern Detection ──────────────────────────
  // Find patterns that appear across different projects/sources

  crossDomainPatterns(domainTag = 'project') {
    const domains = new Map(); // domain -> [nodes]

    for (const node of this.kg.nodes.values()) {
      const tags = node.metadata?.tags || [];
      for (const tag of tags) {
        // Heuristic: project names, sources, etc.
        if (!domains.has(tag)) domains.set(tag, []);
        domains.get(tag).push(node);
      }
    }

    // Find concepts that appear in 2+ domains
    const crossDomain = [];
    const termsByDomain = new Map();

    for (const [domain, nodes] of domains) {
      if (nodes.length < 2) continue;
      const terms = new Set();
      for (const node of nodes) {
        const words = this.kg._tokenize(`${node.title || ''} ${node.body || ''}`);
        for (const w of words) terms.add(w);
      }
      termsByDomain.set(domain, terms);
    }

    const domainList = [...termsByDomain.keys()];
    for (let i = 0; i < domainList.length; i++) {
      for (let j = i + 1; j < domainList.length; j++) {
        const termsA = termsByDomain.get(domainList[i]);
        const termsB = termsByDomain.get(domainList[j]);
        const shared = [...termsA].filter(t => termsB.has(t));

        if (shared.length >= 3) {
          crossDomain.push({
            domains: [domainList[i], domainList[j]],
            sharedTerms: shared.slice(0, 10),
            overlap: shared.length / Math.min(termsA.size, termsB.size)
          });
        }
      }
    }

    return crossDomain.sort((a, b) => b.overlap - a.overlap).slice(0, 20);
  }

  // ── Run Full Analysis ───────────────────────────────────────

  analyze(options = {}) {
    const windowDays = options.windowDays || 30;

    return {
      frequency: this.frequencyAnalysis(windowDays),
      clusters: this.clusterByTags(options.minOverlap || 2),
      anomalies: this.detectAnomalies(),
      crossDomain: this.crossDomainPatterns(),
      timestamp: Date.now()
    };
  }

  // ── Math Utilities ──────────────────────────────────────────

  _pearson(x, y) {
    const n = Math.min(x.length, y.length);
    if (n < 3) return 0;

    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;

    let num = 0, denX = 0, denY = 0;
    for (let i = 0; i < n; i++) {
      const dx = x[i] - meanX;
      const dy = y[i] - meanY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    }

    const den = Math.sqrt(denX * denY);
    return den === 0 ? 0 : num / den;
  }

  _linearRegression(x, y) {
    const n = x.length;
    if (n < 2) return { slope: 0, intercept: 0, r2: 0 };

    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;

    let ssXY = 0, ssXX = 0, ssYY = 0;
    for (let i = 0; i < n; i++) {
      ssXY += (x[i] - meanX) * (y[i] - meanY);
      ssXX += (x[i] - meanX) ** 2;
      ssYY += (y[i] - meanY) ** 2;
    }

    const slope = ssXX === 0 ? 0 : ssXY / ssXX;
    const intercept = meanY - slope * meanX;
    const r2 = ssYY === 0 ? 0 : (ssXY ** 2) / (ssXX * ssYY);

    return { slope, intercept, r2 };
  }

  _sortMap(map, limit = 10) {
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key, count]) => ({ key, count }));
  }

  selfReport() {
    return {
      detectedPatterns: this.detectedPatterns.length,
      capabilities: [
        'frequency-analysis',
        'temporal-correlation',
        'trend-detection',
        'cluster-analysis',
        'anomaly-detection',
        'cross-domain-patterns'
      ]
    };
  }
}

module.exports = PatternEngine;
