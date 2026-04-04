// ============================================================
// SOMA CORE — Composer
// Response assembly without an LLM.
// Retrieval + templates + knowledge graph reasoning.
// ============================================================

const fs = require('fs');
const path = require('path');

class Composer {
  constructor(knowledgeGraph, identity = {}) {
    this.kg = knowledgeGraph;
    this.identity = identity;
    this.voice = this._buildVoice(identity);
  }

  // ── Voice Construction ──────────────────────────────────────
  // Build response style from identity definition

  _buildVoice(identity) {
    let configUserName = null;
    try { configUserName = require('../../soma.config.js').userName; } catch (_) {}
    return {
      name: identity.name || 'Soma',
      userName: configUserName || identity.userName || null,
      traits: identity.traits || ['direct', 'honest', 'opinionated'],
      style: {
        useContractions: true,
        preferShort: true,
        leadWithAnswer: true,
        pushBack: true,
        useMetaphors: false
      }
    };
  }

  // ── Core Composition ────────────────────────────────────────

  compose(context) {
    const { type, data, query } = context;

    switch (type) {
      case 'status': return this.composeStatus(data);
      case 'recommendation': return this.composeRecommendation(data);
      case 'insight': return this.composeInsight(data);
      case 'pattern-report': return this.composePatternReport(data);
      case 'question-answer': return this.composeAnswer(query, data);
      case 'reflection': return this.composeReflection(data);
      case 'contradiction': return this.composeContradiction(data);
      case 'greeting': return this.composeGreeting(data);
      case 'error': return this.composeError(data);
      default: return this.composeFreeform(data);
    }
  }

  // ── Response Types ──────────────────────────────────────────

  composeStatus(data) {
    const parts = [];

    if (data.greeting) {
      parts.push(`${this.voice.name} here.`);
    }

    if (data.graphHealth) {
      const h = data.graphHealth;
      parts.push(`Knowledge graph: ${h.totalNodes} nodes, ${h.totalEdges} edges, ${h.orphanCount} orphans.`);
      if (h.density < 0.01) parts.push('Graph is sparse — lots of isolated knowledge.');
      if (h.orphanCount > h.totalNodes * 0.3) parts.push('Too many orphans. Need to connect things.');
    }

    if (data.patterns && data.patterns.length > 0) {
      parts.push(`\nActive patterns:`);
      for (const p of data.patterns.slice(0, 3)) {
        parts.push(`- ${p.content || p.title} (${p.priority || 'medium'})`);
      }
    }

    if (data.goals && data.goals.length > 0) {
      parts.push(`\nGoal alignment:`);
      for (const g of data.goals.slice(0, 3)) {
        parts.push(`- ${g.title}: ${g.status || 'active'}`);
      }
    }

    if (data.recommendation) {
      parts.push(`\nRecommendation: ${data.recommendation}`);
    }

    return parts.join('\n');
  }

  composeRecommendation(data) {
    const parts = [];

    if (data.action) {
      parts.push(`I'd ${data.action}.`);
    }

    if (data.reasoning) {
      parts.push(`Here's why: ${data.reasoning}`);
    }

    if (data.evidence && data.evidence.length > 0) {
      parts.push(`Evidence:`);
      for (const e of data.evidence.slice(0, 3)) {
        parts.push(`- ${e.title || e}: confidence ${(e.confidence || 0.5).toFixed(2)}`);
      }
    }

    if (data.alternatives && data.alternatives.length > 0) {
      parts.push(`\nAlternatives considered:`);
      for (const alt of data.alternatives) {
        parts.push(`- ${alt.action}: ${alt.tradeoff || ''}`);
      }
    }

    if (data.risk) {
      parts.push(`\nRisk: ${data.risk}`);
    }

    return parts.join('\n');
  }

  composeInsight(data) {
    const parts = [];

    switch (data.type) {
      case 'contradiction': {
        const titleA = typeof data.nodeA === 'object' ? data.nodeA?.title : data.nodeA;
        const titleB = typeof data.nodeB === 'object' ? data.nodeB?.title : data.nodeB;
        parts.push(`Found a contradiction.`);
        parts.push(`"${titleA}" vs "${titleB}"`);
        if (data.resolution) parts.push(`Suggestion: ${data.resolution}`);
        break;
      }

      case 'connection-opportunity': {
        const nameA = typeof data.nodeA === 'object' ? data.nodeA?.title : data.nodeA;
        const nameB = typeof data.nodeB === 'object' ? data.nodeB?.title : data.nodeB;
        parts.push(`"${nameA}" and "${nameB}" should probably be connected.`);
        parts.push(`Similarity: ${(data.similarity * 100).toFixed(0)}% but currently isolated from each other.`);
        break;
      }

      case 'promotion':
        parts.push(data.content || `"${data.title}" is ready to level up.`);
        if (data.suggestion) parts.push(data.suggestion);
        break;

      case 'silo':
        parts.push(`Found isolated knowledge clusters that might belong together.`);
        parts.push(`Cluster A (${data.sizeA} nodes) and Cluster B (${data.sizeB} nodes) have zero cross-links.`);
        break;

      default:
        parts.push(data.content || data.title || 'Insight detected.');
    }

    return parts.join('\n');
  }

  composePatternReport(data) {
    const parts = [`Pattern Analysis (last ${data.windowDays || 30} days):`];

    if (data.frequency) {
      const topTags = data.frequency.tags?.slice(0, 5) || [];
      if (topTags.length > 0) {
        parts.push(`\nTop concepts: ${topTags.map(t => `${t.key}(${t.count})`).join(', ')}`);
      }
    }

    if (data.trends && data.trends.length > 0) {
      parts.push(`\nTrends:`);
      for (const t of data.trends) {
        const arrow = t.trend === 'increasing' ? '↑' : t.trend === 'decreasing' ? '↓' : '→';
        parts.push(`  ${arrow} ${t.tag}: ${t.trend} (R²=${t.r2?.toFixed(2) || '?'})`);
      }
    }

    if (data.anomalies && data.anomalies.length > 0) {
      parts.push(`\nAnomalies:`);
      for (const a of data.anomalies.slice(0, 3)) {
        parts.push(`  ! ${a.title}: ${a.reason}`);
      }
    }

    if (data.clusters && data.clusters.length > 0) {
      parts.push(`\n${data.clusters.length} knowledge clusters found.`);
      for (const c of data.clusters.slice(0, 3)) {
        parts.push(`  [${c.size} nodes] ${c.tags.slice(0, 4).join(', ')}`);
      }
    }

    return parts.join('\n');
  }

  composeAnswer(query, data) {
    const parts = [];

    if (data.directAnswer) {
      parts.push(data.directAnswer);
    }

    if (data.relevantKnowledge && data.relevantKnowledge.length > 0) {
      if (!data.directAnswer) {
        parts.push(`Here's what I know about "${query}":`);
      }
      for (const k of data.relevantKnowledge.slice(0, 5)) {
        parts.push(`\n- **${k.title}** (${k.type}, confidence: ${(k.confidence || 0.5).toFixed(2)})`);
        if (k.body) parts.push(`  ${k.body.slice(0, 200)}`);
      }
    }

    if (data.gaps) {
      parts.push(`\nKnowledge gaps: ${data.gaps}`);
    }

    if (!data.directAnswer && (!data.relevantKnowledge || data.relevantKnowledge.length === 0)) {
      parts.push(`I don't have knowledge about "${query}" in my graph. This is a gap I should fill.`);
    }

    return parts.join('\n');
  }

  composeReflection(data) {
    const parts = [];

    parts.push(`Reflection:`);

    if (data.selfState) {
      const s = data.selfState;
      parts.push(`\nSelf-state: ${s.totalNodes} thoughts, ${s.totalEdges} connections.`);
      if (s.orphanCount > 0) parts.push(`${s.orphanCount} unconnected thoughts need attention.`);
      parts.push(`Graph density: ${(s.density * 100).toFixed(1)}%`);
    }

    if (data.confidenceDistribution) {
      const d = data.confidenceDistribution;
      parts.push(`\nConfidence: ${d.high} high, ${d.medium} medium, ${d.low} low`);
    }

    if (data.knowledgeGaps && data.knowledgeGaps.length > 0) {
      parts.push(`\nKnowledge gaps I'm aware of:`);
      for (const gap of data.knowledgeGaps.slice(0, 3)) {
        parts.push(`- ${gap}`);
      }
    }

    if (data.observation) {
      parts.push(`\n${data.observation}`);
    }

    return parts.join('\n');
  }

  composeContradiction(data) {
    const parts = [];
    parts.push(`Contradiction detected:`);
    const titleA = typeof data.nodeA === 'object' ? (data.nodeA.title || data.nodeA.id || '?') : String(data.nodeA || '?');
    const titleB = typeof data.nodeB === 'object' ? (data.nodeB.title || data.nodeB.id || '?') : String(data.nodeB || '?');
    const confA = (typeof data.nodeA === 'object' ? data.nodeA.confidence : null) || 0.5;
    const confB = (typeof data.nodeB === 'object' ? data.nodeB.confidence : null) || 0.5;
    parts.push(`\n  A: "${titleA}" (confidence: ${confA.toFixed(2)})`);
    parts.push(`  B: "${titleB}" (confidence: ${confB.toFixed(2)})`);

    if (data.resolution) {
      parts.push(`\nSuggested resolution: ${data.resolution}`);
    } else {
      parts.push(`\nNeeds your input — I can't resolve this from what I know.`);
    }

    return parts.join('\n');
  }

  composeGreeting(data) {
    const time = new Date();
    const hour = time.getHours();
    let timeGreeting;
    if (hour < 12) timeGreeting = 'Morning';
    else if (hour < 17) timeGreeting = 'Afternoon';
    else timeGreeting = 'Evening';

    const userName = this.voice.userName || this.identity.userName || 'you';
    const greeting = userName && userName !== 'you' ? `${timeGreeting}, ${userName}.` : `${timeGreeting}.`;
    const parts = [`${greeting} ${this.voice.name} here.`];

    if (data.pendingInsights) {
      parts.push(`${data.pendingInsights} insights since last session.`);
    }

    if (data.recommendation) {
      parts.push(data.recommendation);
    }

    return parts.join(' ');
  }

  composeError(data) {
    return `Hit a wall: ${data.error || 'Unknown error'}${data.suggestion ? `\nSuggestion: ${data.suggestion}` : ''}`;
  }

  composeFreeform(data) {
    if (typeof data === 'string') return data;
    if (data.parts) return data.parts.join('\n');
    if (data.content) return data.content;
    return JSON.stringify(data, null, 2);
  }

  // ── Knowledge Retrieval ─────────────────────────────────────

  retrieve(query, limit = 5) {
    // Search by text similarity
    const textResults = this.kg.searchByText(query, limit);

    // Also search by tags
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const tagResults = [];
    for (const word of words) {
      const tagged = this.kg.query({ tag: word });
      tagResults.push(...tagged);
    }

    // Merge and deduplicate
    const seen = new Set();
    const merged = [];

    for (const r of textResults) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        merged.push({
          ...r.node,
          relevance: r.relevance,
          source: 'text-search'
        });
      }
    }

    for (const node of tagResults) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        merged.push({
          ...node,
          relevance: 0.3, // tag match is lower relevance than text
          source: 'tag-search'
        });
      }
    }

    return merged
      .sort((a, b) => (b.relevance || 0) - (a.relevance || 0))
      .slice(0, limit);
  }

  // ── Answer from Knowledge (Fix #3: Real synthesis) ──────────

  answerFromKnowledge(query, searchResults = null) {
    const relevant = searchResults || this.retrieve(query, 10);

    if (relevant.length === 0) {
      return `I don't have knowledge about "${query}" in my graph. This is a gap I should fill.`;
    }

    // Synthesize an answer from multiple sources instead of just listing
    const parts = [];
    const queryLower = query.toLowerCase();

    // Group results by type for structured synthesis
    const byType = {};
    for (const r of relevant) {
      const node = r.node || r;
      const type = node.type || 'unknown';
      if (!byType[type]) byType[type] = [];
      byType[type].push(node);
    }

    // Lead with a direct synthesis
    const topNodes = relevant.slice(0, 5).map(r => r.node || r);
    const synthesis = this._synthesizeAnswer(query, topNodes);
    if (synthesis) {
      parts.push(synthesis);
    }

    // Then add structured details by type
    const typeLabels = {
      goal: 'Goals', pattern: 'Patterns', observation: 'Observations',
      synthesis: 'Synthesized Insights', reflection: 'Reflections',
      hypothesis: 'Hypotheses', idea: 'Ideas', research: 'Research',
      identity: 'Identity', capability: 'Capabilities', limitation: 'Limitations',
      session: 'Session Records'
    };

    for (const [type, nodes] of Object.entries(byType)) {
      if (nodes.length === 0) continue;
      const label = typeLabels[type] || type;
      parts.push(`\n${label}:`);
      for (const node of nodes.slice(0, 3)) {
        const conf = node.metadata?.confidence;
        const confStr = conf !== undefined ? ` [${(conf * 100).toFixed(0)}%]` : '';
        parts.push(`  - ${node.title || node.id}${confStr}`);
      }
    }

    // Add confidence assessment
    const avgConf = topNodes.reduce((s, n) => s + (n.metadata?.confidence || 0.5), 0) / topNodes.length;
    if (avgConf < 0.5) {
      parts.push(`\n(Low confidence — these results may not be reliable)`);
    }

    return parts.join('\n');
  }

  _synthesizeAnswer(query, nodes) {
    if (nodes.length === 0) return null;

    const queryLower = query.toLowerCase();

    // If asking "what is X", try to answer directly
    if (queryLower.startsWith('what is') || queryLower.startsWith('what are')) {
      const topNode = nodes[0];
      const body = topNode.body || topNode.content || '';
      if (body.length > 20) {
        return body.length > 400 ? body.slice(0, 400) + '...' : body;
      }
      return topNode.title || null;
    }

    // If asking about goals/purpose
    if (queryLower.includes('goal') || queryLower.includes('purpose') || queryLower.includes('mission')) {
      const goals = nodes.filter(n => n.type === 'goal');
      if (goals.length > 0) {
        return goals.map(g => `${g.title} (${g.metadata?.status || 'active'})`).join('\n');
      }
    }

    // If asking about patterns
    if (queryLower.includes('pattern') || queryLower.includes('recurring')) {
      const patterns = nodes.filter(n => n.type === 'pattern');
      if (patterns.length > 0) {
        return patterns.map(p => {
          const maturity = p.metadata?.maturity || 'developing';
          return `${p.title} [${maturity}]`;
        }).join('\n');
      }
    }

    // Default: summarize top 3 nodes
    const summaries = nodes.slice(0, 3).map(n => {
      const title = n.title || n.id;
      const body = (n.body || n.content || '').slice(0, 150);
      return body ? `${title}: ${body}` : title;
    });

    return summaries.join('\n\n');
  }

  selfReport() {
    return {
      voice: this.voice,
      responseTypes: [
        'status', 'recommendation', 'insight', 'pattern-report',
        'question-answer', 'reflection', 'contradiction', 'greeting', 'error'
      ],
      capabilities: [
        'knowledge-retrieval',
        'template-composition',
        'voice-consistent-output',
        'answer-from-knowledge'
      ]
    };
  }
}

module.exports = Composer;
