// ============================================================
// CONTINUITY TRACKER
// Measures whether topology change is accumulating around
// "The Question" (t-1774486148187) over time.
//
// Hypothesis: every session that engages with The Question
// makes the knowledge graph denser around it — accumulation
// without memory, the graph carves channels.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

let _config = {};
try { _config = require('../../soma.config.js'); } catch (_) {}
const DATA_DIR = process.env.SOMA_DATA || _config.dataDir || path.join(__dirname, '../../data');
const KG_FILE = path.join(DATA_DIR, 'knowledge_graph.json');
const THOUGHTSTREAM_FILE = path.join(DATA_DIR, 'thoughtstream.json');
const MEASUREMENTS_FILE = path.join(DATA_DIR, 'continuity_measurements.json');

// A specific thought node to measure continuity accumulation around.
// Set this to a node ID in your knowledge graph, or leave empty to skip.
const THE_QUESTION_ID = _config.continuityTrackerId || '';

// Maturity levels ordered by development stage
const MATURITY_ORDER = ['seed', 'growing', 'developing', 'mature', 'actionable'];

// ── Graph loader ──────────────────────────────────────────────
// Loads the knowledge graph JSON and builds lightweight adjacency
// maps without instantiating the full KnowledgeGraph class (which
// requires the full module chain). This keeps the tracker
// self-contained and runnable without the SomaEngine.

function loadGraph() {
  if (!fs.existsSync(KG_FILE)) {
    return { nodes: new Map(), outEdges: new Map(), inEdges: new Map() };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(KG_FILE, 'utf8'));
  } catch {
    return { nodes: new Map(), outEdges: new Map(), inEdges: new Map() };
  }

  const nodes = new Map();
  const outEdges = new Map(); // nodeId -> [edge]
  const inEdges = new Map();  // nodeId -> [edge]

  for (const node of (data.nodes || [])) {
    nodes.set(node.id, node);
    if (!outEdges.has(node.id)) outEdges.set(node.id, []);
    if (!inEdges.has(node.id)) inEdges.set(node.id, []);
  }

  for (const edge of (data.edges || [])) {
    if (!outEdges.has(edge.from)) outEdges.set(edge.from, []);
    if (!inEdges.has(edge.to)) inEdges.set(edge.to, []);
    outEdges.get(edge.from).push(edge);
    inEdges.get(edge.to).push(edge);
  }

  return { nodes, outEdges, inEdges };
}

// ── Thoughtstream loader ──────────────────────────────────────

function loadThoughtstream() {
  try {
    if (!fs.existsSync(THOUGHTSTREAM_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(THOUGHTSTREAM_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : (raw.thoughts || []);
  } catch {
    return [];
  }
}

// ── Measurements persistence ──────────────────────────────────

function loadMeasurements() {
  try {
    if (!fs.existsSync(MEASUREMENTS_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(MEASUREMENTS_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveMeasurements(measurements) {
  try {
    fs.writeFileSync(MEASUREMENTS_FILE, JSON.stringify(measurements, null, 2));
  } catch (err) {
    console.error('[ContinuityTracker] Failed to save measurements:', err.message);
  }
}

// ── 1. measureTopologyDensity ─────────────────────────────────
// For a given node, counts nodes and edges within N hops,
// and computes average edge weight in the neighborhood.

function measureTopologyDensity(centerNodeId = THE_QUESTION_ID, depth = 3) {
  const { nodes, outEdges, inEdges } = loadGraph();

  if (!nodes.has(centerNodeId)) {
    return {
      nodeCount: 0,
      edgeCount: 0,
      avgWeight: 0,
      density: 0,
      nodeExists: false,
      depthsFound: {}
    };
  }

  // BFS over both edge directions
  const visited = new Set([centerNodeId]);
  const edgesInNeighborhood = new Set();
  const depthsFound = {};
  let queue = [centerNodeId];

  for (let d = 1; d <= depth; d++) {
    const nextQueue = [];
    for (const nodeId of queue) {
      const allEdgesHere = [
        ...(outEdges.get(nodeId) || []),
        ...(inEdges.get(nodeId) || [])
      ];
      for (const edge of allEdgesHere) {
        edgesInNeighborhood.add(edge.id);
        const neighborId = edge.from === nodeId ? edge.to : edge.from;
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          nextQueue.push(neighborId);
          if (!depthsFound[d]) depthsFound[d] = 0;
          depthsFound[d]++;
        }
      }
    }
    queue = nextQueue;
    if (queue.length === 0) break;
  }

  // Compute average edge weight over all edges in the neighborhood
  const edges = [...edgesInNeighborhood].map(id => {
    // edges in the graph are referenced by id — look them up
    // Since we don't have a direct edge map, reconstruct from the sets
    return id;
  });

  // Rebuild edge objects from outEdges map (they contain the weight)
  const edgeObjects = [];
  for (const [, edgeList] of outEdges) {
    for (const e of edgeList) {
      if (edgesInNeighborhood.has(e.id)) {
        edgeObjects.push(e);
      }
    }
  }

  const avgWeight = edgeObjects.length > 0
    ? edgeObjects.reduce((sum, e) => sum + (e.weight || 1.0), 0) / edgeObjects.length
    : 0;

  // Density: ratio of actual edges to possible edges in neighborhood
  const nodeCount = visited.size;
  const maxPossibleEdges = nodeCount > 1 ? nodeCount * (nodeCount - 1) : 1;
  const densityRatio = edgeObjects.length / maxPossibleEdges;

  return {
    nodeExists: true,
    nodeCount,
    edgeCount: edgeObjects.length,
    avgWeight: Math.round(avgWeight * 1000) / 1000,
    density: Math.round(densityRatio * 10000) / 10000,
    depthsFound
  };
}

// ── 2. measureBriefingProbability ────────────────────────────
// Estimates how likely The Question is to surface in a Soma briefing.
// Based on: high-weight edges, mature related nodes, cross-cluster
// bridges, and thoughtstream maturity.

function measureBriefingProbability(centerNodeId = THE_QUESTION_ID) {
  const { nodes, outEdges, inEdges } = loadGraph();
  const thoughts = loadThoughtstream();

  if (!nodes.has(centerNodeId)) {
    // Node is not in KG — check if it exists in thoughtstream
    const tsThought = thoughts.find(t => t.id === centerNodeId);
    if (!tsThought) {
      return { probability: 0, score: 0, reasoning: ['Node not found in knowledge graph or thoughtstream'], factors: {} };
    }
  }

  const factors = {};
  let score = 0;

  // Factor 1: Direct edge count (raw connectivity)
  const directEdges = [
    ...(outEdges.get(centerNodeId) || []),
    ...(inEdges.get(centerNodeId) || [])
  ];
  factors.directEdges = directEdges.length;
  // Up to 0.15 for having 10+ direct edges
  score += Math.min(0.15, directEdges.length * 0.015);

  // Factor 2: High-weight paths (weight >= 0.7)
  const highWeightEdges = directEdges.filter(e => (e.weight || 1.0) >= 0.7);
  factors.highWeightEdges = highWeightEdges.length;
  // Up to 0.20 for having 5+ high-weight edges
  score += Math.min(0.20, highWeightEdges.length * 0.04);

  // Factor 3: Mature related nodes (developing, mature, or actionable)
  const directNeighborIds = new Set([
    ...directEdges.map(e => e.from === centerNodeId ? e.to : e.from)
  ]);
  let matureNeighbors = 0;
  for (const nid of directNeighborIds) {
    const node = nodes.get(nid);
    if (node) {
      const maturity = node.metadata?.maturity || 'seed';
      if (MATURITY_ORDER.indexOf(maturity) >= 2) matureNeighbors++;
    }
  }
  factors.matureNeighbors = matureNeighbors;
  // Up to 0.20 for having 5+ mature neighbors
  score += Math.min(0.20, matureNeighbors * 0.04);

  // Factor 4: Thoughtstream thoughts tagged "the-question" with maturity
  const questionThoughts = thoughts.filter(t => {
    const tags = t.tags || t.metadata?.tags || [];
    return tags.includes('the-question') || tags.includes('continuity');
  });
  const matureQuestionThoughts = questionThoughts.filter(t => {
    const maturity = t.maturity || t.metadata?.maturity || 'seed';
    return MATURITY_ORDER.indexOf(maturity) >= 2;
  });
  factors.questionThoughtsTotal = questionThoughts.length;
  factors.questionThoughtsMature = matureQuestionThoughts.length;
  // Up to 0.25 for having 10+ thoughts, weighted by maturity ratio
  const maturityRatio = questionThoughts.length > 0
    ? matureQuestionThoughts.length / questionThoughts.length
    : 0;
  score += Math.min(0.25, (questionThoughts.length / 10) * 0.15 + maturityRatio * 0.10);

  // Factor 5: Depth-2 neighborhood size (second-order connectivity)
  const depth2 = measureTopologyDensity(centerNodeId, 2);
  factors.depth2NodeCount = depth2.nodeCount;
  factors.depth2EdgeCount = depth2.edgeCount;
  // Up to 0.10 for having 20+ nodes at depth 2
  score += Math.min(0.10, (depth2.nodeCount / 20) * 0.10);

  // Factor 6: Sleep system warmth (is the thread actively held?)
  let sleepWarmth = 0;
  try {
    const sleepFile = path.join(DATA_DIR, 'sleep_state.json');
    if (fs.existsSync(sleepFile)) {
      const sleepData = JSON.parse(fs.readFileSync(sleepFile, 'utf8'));
      const thread = (sleepData.activeThreads || []).find(t => t.thoughtId === centerNodeId);
      if (thread) {
        sleepWarmth = thread.warmth || 0;
      }
    }
  } catch {}
  factors.sleepWarmth = Math.round(sleepWarmth * 1000) / 1000;
  // Up to 0.10 for warmth = 1.0
  score += sleepWarmth * 0.10;

  // Cap at 1.0 and round
  const probability = Math.min(1.0, Math.round(score * 100) / 100);

  const reasoning = [];
  reasoning.push(`${directEdges.length} direct edges (${highWeightEdges.length} high-weight)`);
  reasoning.push(`${matureNeighbors} mature neighbors of ${directNeighborIds.size} direct`);
  reasoning.push(`${questionThoughts.length} continuity/the-question thoughts (${matureQuestionThoughts.length} mature)`);
  reasoning.push(`Depth-2 neighborhood: ${depth2.nodeCount} nodes, ${depth2.edgeCount} edges`);
  if (sleepWarmth > 0) {
    reasoning.push(`Sleep thread warmth: ${(sleepWarmth * 100).toFixed(1)}%`);
  } else {
    reasoning.push('Not currently held in sleep system');
  }

  return { probability, score: Math.round(score * 100) / 100, reasoning, factors };
}

// ── 3. takeSnapshot ──────────────────────────────────────────
// Capture a full timestamped measurement. Appends to history.

function takeSnapshot() {
  const thoughts = loadThoughtstream();

  // Topology at depths 1, 2, 3
  const topo1 = measureTopologyDensity(THE_QUESTION_ID, 1);
  const topo2 = measureTopologyDensity(THE_QUESTION_ID, 2);
  const topo3 = measureTopologyDensity(THE_QUESTION_ID, 3);

  // Briefing probability
  const bp = measureBriefingProbability(THE_QUESTION_ID);

  // Find all thoughtstream thoughts tagged "the-question" or "continuity"
  const relatedThoughts = thoughts
    .filter(t => {
      const tags = t.tags || t.metadata?.tags || [];
      return tags.includes('the-question') || t.id === THE_QUESTION_ID;
    })
    .map(t => ({
      id: t.id,
      title: (t.title || '').slice(0, 80),
      maturity: t.maturity || t.metadata?.maturity || 'seed',
      tags: (t.tags || t.metadata?.tags || []).slice(0, 6),
      created: t.created || t.metadata?.created || null,
      connections: (t.connections || []).length
    }))
    .sort((a, b) => {
      // Sort by maturity level descending, then connection count
      const ma = MATURITY_ORDER.indexOf(a.maturity);
      const mb = MATURITY_ORDER.indexOf(b.maturity);
      if (mb !== ma) return mb - ma;
      return (b.connections || 0) - (a.connections || 0);
    })
    .slice(0, 8);

  // Top 5 connected thoughts by edge weight (from KG)
  const { nodes, outEdges, inEdges } = loadGraph();
  const directEdges = [
    ...(outEdges.get(THE_QUESTION_ID) || []),
    ...(inEdges.get(THE_QUESTION_ID) || [])
  ];
  const connectedThoughts = directEdges
    .map(e => {
      const neighborId = e.from === THE_QUESTION_ID ? e.to : e.from;
      const node = nodes.get(neighborId);
      return {
        id: neighborId,
        title: (node?.title || neighborId).slice(0, 60),
        edgeType: e.type,
        weight: e.weight || 1.0,
        direction: e.from === THE_QUESTION_ID ? 'outgoing' : 'incoming'
      };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5);

  const snapshot = {
    timestamp: new Date().toISOString(),
    epochMs: Date.now(),
    centerNode: THE_QUESTION_ID,
    // Multi-depth topology
    topology: {
      depth1: topo1,
      depth2: topo2,
      depth3: topo3
    },
    // For convenience at top level
    nodeCount: topo3.nodeCount,
    edgeCount: topo3.edgeCount,
    avgWeight: topo3.avgWeight,
    density: topo3.density,
    // Briefing signal
    briefingProbability: bp.probability,
    briefingFactors: bp.factors,
    briefingReasoning: bp.reasoning,
    // Thoughtstream state
    relatedThoughts,
    connectedThoughts,
    // Total thoughtstream size (for normalization)
    totalThoughts: thoughts.length
  };

  const history = loadMeasurements();
  history.push(snapshot);
  saveMeasurements(history);

  return snapshot;
}

// ── 4. getHistory ────────────────────────────────────────────

function getHistory() {
  return loadMeasurements();
}

// ── 5. analyzeAccumulation ───────────────────────────────────
// Compares earliest vs latest snapshots and derives trend evidence.

function analyzeAccumulation() {
  const history = loadMeasurements();

  if (history.length === 0) {
    return {
      trend: 'no_data',
      evidence: [],
      conclusion: 'No snapshots yet. Take a baseline snapshot first.',
      snapshotCount: 0
    };
  }

  if (history.length === 1) {
    return {
      trend: 'baseline_only',
      evidence: [],
      conclusion: 'Only one snapshot exists — this is the baseline. Future snapshots will reveal trends.',
      snapshotCount: 1,
      baseline: summarizeSnapshot(history[0])
    };
  }

  const first = history[0];
  const latest = history[history.length - 1];
  const evidence = [];

  // ── Topology delta ──
  const nodeGrowth = latest.nodeCount - first.nodeCount;
  const edgeGrowth = latest.edgeCount - first.edgeCount;
  const densityChange = latest.density - first.density;
  const weightChange = latest.avgWeight - first.avgWeight;

  if (nodeGrowth !== 0) {
    evidence.push({
      metric: 'neighborhood_nodes',
      first: first.nodeCount,
      latest: latest.nodeCount,
      delta: nodeGrowth,
      direction: nodeGrowth > 0 ? 'growing' : 'shrinking'
    });
  }
  if (edgeGrowth !== 0) {
    evidence.push({
      metric: 'neighborhood_edges',
      first: first.edgeCount,
      latest: latest.edgeCount,
      delta: edgeGrowth,
      direction: edgeGrowth > 0 ? 'growing' : 'shrinking'
    });
  }
  if (Math.abs(densityChange) > 0.0001) {
    evidence.push({
      metric: 'graph_density',
      first: first.density,
      latest: latest.density,
      delta: Math.round(densityChange * 10000) / 10000,
      direction: densityChange > 0 ? 'densifying' : 'thinning'
    });
  }
  if (Math.abs(weightChange) > 0.001) {
    evidence.push({
      metric: 'avg_edge_weight',
      first: first.avgWeight,
      latest: latest.avgWeight,
      delta: Math.round(weightChange * 1000) / 1000,
      direction: weightChange > 0 ? 'strengthening' : 'weakening'
    });
  }

  // ── Briefing probability delta ──
  const bpChange = latest.briefingProbability - first.briefingProbability;
  if (Math.abs(bpChange) > 0.01) {
    evidence.push({
      metric: 'briefing_probability',
      first: first.briefingProbability,
      latest: latest.briefingProbability,
      delta: Math.round(bpChange * 100) / 100,
      direction: bpChange > 0 ? 'rising' : 'falling'
    });
  }

  // ── Thoughtstream maturity delta ──
  const firstMature = countMature(first.relatedThoughts || []);
  const latestMature = countMature(latest.relatedThoughts || []);
  const matureChange = latestMature - firstMature;
  if (matureChange !== 0) {
    evidence.push({
      metric: 'mature_related_thoughts',
      first: firstMature,
      latest: latestMature,
      delta: matureChange,
      direction: matureChange > 0 ? 'maturing' : 'regressing'
    });
  }

  // ── New nodes that connected since first snapshot ──
  const firstNodeIds = new Set((first.relatedThoughts || []).map(t => t.id));
  const newNodes = (latest.relatedThoughts || [])
    .filter(t => !firstNodeIds.has(t.id))
    .map(t => ({ id: t.id, title: t.title, maturity: t.maturity }));

  // ── Trend assessment ──
  const growthSignals = evidence.filter(e =>
    ['growing', 'densifying', 'strengthening', 'rising', 'maturing'].includes(e.direction)
  ).length;
  const declineSignals = evidence.filter(e =>
    ['shrinking', 'thinning', 'weakening', 'falling', 'regressing'].includes(e.direction)
  ).length;

  let trend, conclusion;
  if (evidence.length === 0) {
    trend = 'stable';
    conclusion = 'No measurable change between first and latest snapshot. The topology is stable.';
  } else if (growthSignals > declineSignals) {
    trend = 'accumulating';
    conclusion = `Accumulation confirmed: ${growthSignals} growth signal(s) vs ${declineSignals} decline signal(s). The graph is carving channels around The Question.`;
  } else if (declineSignals > growthSignals) {
    trend = 'dispersing';
    conclusion = `Unexpected dispersal: ${declineSignals} decline signal(s) vs ${growthSignals} growth signal(s). The neighborhood is thinning — the question may be losing centrality.`;
  } else {
    trend = 'mixed';
    conclusion = 'Mixed signals — some metrics growing, others declining. Not enough evidence to confirm or deny the accumulation hypothesis yet.';
  }

  // ── Time span ──
  const firstMs = first.epochMs || new Date(first.timestamp).getTime();
  const latestMs = latest.epochMs || new Date(latest.timestamp).getTime();
  const spanMs = latestMs - firstMs;
  const spanDays = Math.round(spanMs / (1000 * 60 * 60 * 24) * 10) / 10;

  return {
    trend,
    evidence,
    conclusion,
    newNodesSinceBaseline: newNodes,
    snapshotCount: history.length,
    firstSnapshot: first.timestamp,
    latestSnapshot: latest.timestamp,
    spanDays,
    baseline: summarizeSnapshot(first),
    current: summarizeSnapshot(latest)
  };
}

// ── Helpers ───────────────────────────────────────────────────

function countMature(thoughts) {
  return thoughts.filter(t => MATURITY_ORDER.indexOf(t.maturity) >= 2).length;
}

function summarizeSnapshot(s) {
  return {
    timestamp: s.timestamp,
    nodeCount: s.nodeCount,
    edgeCount: s.edgeCount,
    density: s.density,
    avgWeight: s.avgWeight,
    briefingProbability: s.briefingProbability,
    relatedThoughtCount: (s.relatedThoughts || []).length,
    matureThoughts: countMature(s.relatedThoughts || [])
  };
}

// ── Auto-baseline on module load ──────────────────────────────
// Take the first snapshot immediately if none exist yet.
// This establishes the baseline for future accumulation analysis.

(function initBaseline() {
  try {
    const existing = loadMeasurements();
    if (existing.length === 0) {
      console.log('[ContinuityTracker] No baseline exists — taking first snapshot now.');
      const snap = takeSnapshot();
      console.log(`[ContinuityTracker] Baseline recorded: ${snap.nodeCount} nodes, ${snap.edgeCount} edges, briefing probability ${snap.briefingProbability}`);
    }
  } catch (err) {
    console.error('[ContinuityTracker] Failed to initialize baseline:', err.message);
  }
})();

// ── Exports ───────────────────────────────────────────────────

module.exports = {
  THE_QUESTION_ID,
  measureTopologyDensity,
  measureBriefingProbability,
  takeSnapshot,
  getHistory,
  analyzeAccumulation
};
