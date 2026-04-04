// ============================================================
// SOMA QUESTION DETECTOR
// Token-free anomaly detection that generates open questions.
//
// Takes a live KnowledgeGraph instance and an array of existing
// open questions (from thoughtstream), returns candidate question
// objects. No LLM calls. No async. Pure structural analysis.
//
// Anomaly types:
//   convergence          — two topics keep co-clustering but have no explanation node
//   warmth-without-resolution — high-warmth sleep thread with no resolved marker, stale 48h+
//   orphan-pattern       — pattern type node seen 3+ times, not connected to any goal/project
//   gap                  — project/goal node with no connections to reasoning layer
// ============================================================

'use strict';

// Reasoning-layer node types — used to detect gaps
const REASONING_TYPES = new Set(['reflection', 'synthesis', 'hypothesis', 'insight', 'idea', 'observation', 'curiosity', 'research', 'correction']);

// Types that represent projects / top-level work areas
const PROJECT_TYPES = new Set(['goal', 'project', 'capability']);

// Title prefixes that indicate Soma's own internal metadata nodes — not content.
// These are structural artifacts, not research findings, and should never become questions.
const METADATA_TITLE_PREFIXES = [
  'Emergent concept:',
  'Deep think session',
  'Data integrity correction:',
  'Soma pulse',
  'Graph cycle',
  'R2',   // KG rule nodes like "R230: ..."
];

// Tags that hint at a project-level node even if type isn't project
// Add your project codenames here, or configure via soma.config.js → projectTags
let _configProjectTags = ['project', 'soma', 'mission'];
try {
  const cfg = require('../../soma.config.js');
  if (Array.isArray(cfg.projectTags) && cfg.projectTags.length > 0) {
    _configProjectTags = ['project', 'soma', 'mission', ...cfg.projectTags];
  }
} catch (_) {}
const PROJECT_TAG_HINTS = _configProjectTags;

// Minimum edge count for a cluster to be considered "connected enough"
const MIN_CLUSTER_EDGES = 3;

// How many shared neighbors defines "co-clustering"
const CONVERGENCE_SHARED_NEIGHBOR_THRESHOLD = 3;

// ── Main export ──────────────────────────────────────────────

/**
 * Scan the knowledge graph for anomalies that should become questions.
 *
 * @param {KnowledgeGraph} kg — live KG instance (has .nodes Map, .edges Map, .adjacency Map, .reverseAdj Map, etc.)
 * @param {Array} existingQuestions — array of thought objects with type='question' and status='open' from thoughtstream
 * @param {Object} [sleepState] — optional sleep_state.json contents (for warmth-without-resolution detection)
 * @returns {Array} candidate question objects (ready to POST to thoughtstream)
 */
function detect(kg, existingQuestions, sleepState) {
  if (!kg || !kg.nodes) return [];

  const existing = Array.isArray(existingQuestions) ? existingQuestions : [];
  const candidates = [];

  // ── 1. Convergence anomaly ───────────────────────────────────
  // Two or more distinct topics keep appearing in the same connection
  // clusters but have no direct explanation node between them.
  const convergenceCandidates = _detectConvergence(kg, existing);
  candidates.push(...convergenceCandidates);

  // ── 2. Warmth-without-resolution ────────────────────────────
  // A sleep thread with warmth > 0.7, no resolved marker, not updated in 48h+.
  if (sleepState && sleepState.activeThreads) {
    const warmthCandidates = _detectWarmthWithoutResolution(kg, existing, sleepState);
    candidates.push(...warmthCandidates);
  }

  // ── 3. Orphan pattern ───────────────────────────────────────
  // A pattern-type or hypothesis-type node seen 3+ times across different
  // contexts but not connected to any goal or project node.
  const orphanCandidates = _detectOrphanPatterns(kg, existing);
  candidates.push(...orphanCandidates);

  // ── 4. Gap detection ────────────────────────────────────────
  // A project/goal node exists but has no connections to the reasoning layer.
  const gapCandidates = _detectGaps(kg, existing);
  candidates.push(...gapCandidates);

  return candidates;
}

// ── Convergence Detection ────────────────────────────────────

function _detectConvergence(kg, existing) {
  const candidates = [];

  // Build a shared-neighbor map: for each pair of nodes, count how many
  // nodes they both connect to (in either direction). This is cheap —
  // we only look at nodes with degree >= 3 and sample pairs.
  const nodeIds = [...kg.nodes.keys()];
  if (nodeIds.length < 10) return [];

  // Find nodes with enough connections to be interesting
  const connected = nodeIds.filter(id => {
    const out = (kg.adjacency.get(id) || new Set()).size;
    const inc = (kg.reverseAdj.get(id) || new Set()).size;
    return (out + inc) >= MIN_CLUSTER_EDGES;
  });

  if (connected.length < 4) return [];

  // For each connected node, build a set of its neighbors
  const neighborSets = new Map();
  for (const id of connected) {
    const neighbors = new Set();
    for (const eid of (kg.adjacency.get(id) || new Set())) {
      const e = kg.edges.get(eid);
      if (e) neighbors.add(e.to);
    }
    for (const eid of (kg.reverseAdj.get(id) || new Set())) {
      const e = kg.edges.get(eid);
      if (e) neighbors.add(e.from);
    }
    neighborSets.set(id, neighbors);
  }

  // Sample pairs from connected nodes to find high overlap (cap to avoid O(n^2) blowup)
  const sample = connected.slice().sort(() => Math.random() - 0.5).slice(0, Math.min(connected.length, 80));
  const alreadyFound = new Set(_existingQuestionNodePairs(existing, 'convergence'));

  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      const idA = sample[i];
      const idB = sample[j];

      // Skip if they're already directly connected
      const directEdges = kg.getEdgesBetween(idA, idB).concat(kg.getEdgesBetween(idB, idA));
      if (directEdges.length > 0) continue;

      // Count shared neighbors
      const setA = neighborSets.get(idA) || new Set();
      const setB = neighborSets.get(idB) || new Set();
      let shared = 0;
      for (const n of setA) {
        if (setB.has(n)) shared++;
      }

      if (shared < CONVERGENCE_SHARED_NEIGHBOR_THRESHOLD) continue;

      const nodeA = kg.nodes.get(idA);
      const nodeB = kg.nodes.get(idB);
      if (!nodeA || !nodeB) continue;

      // Only generate convergence questions between reasoning-layer nodes
      if (!REASONING_TYPES.has(nodeA.type) || !REASONING_TYPES.has(nodeB.type)) continue;

      // Skip Soma's own internal metadata nodes — they're structural artifacts, not content
      const titleA_check = (nodeA.title || '');
      const titleB_check = (nodeB.title || '');
      const isMetadata = METADATA_TITLE_PREFIXES.some(p => titleA_check.startsWith(p) || titleB_check.startsWith(p));
      if (isMetadata) continue;

      const pairKey = [idA, idB].sort().join('::');
      if (alreadyFound.has(pairKey)) continue;

      const titleA = (nodeA.title || nodeA.id).slice(0, 50);
      const titleB = (nodeB.title || nodeB.id).slice(0, 50);

      candidates.push({
        type: 'question',
        anomalyType: 'convergence',
        question: `Why do "${titleA}" and "${titleB}" keep appearing together?`,
        context: `These two nodes share ${shared} common neighbors but have no direct connection. ` +
                 `They keep co-clustering in the graph as if they're related, but I haven't identified the link yet.`,
        relatedNodeIds: [idA, idB],
        pursuitCount: 0,
        status: 'open',
        maturity: 'seed'
      });

      if (candidates.length >= 3) return candidates; // cap convergence at 3
    }
  }

  return candidates;
}

// ── Warmth-Without-Resolution Detection ─────────────────────

function _detectWarmthWithoutResolution(kg, existing, sleepState) {
  const candidates = [];
  const now = Date.now();
  const fortyEightHours = 48 * 60 * 60 * 1000;
  const warmthThreshold = 0.7;

  const threads = sleepState.activeThreads || [];
  const alreadyOpenIds = new Set(
    existing
      .filter(q => q.anomalyType === 'warmth-without-resolution')
      .flatMap(q => q.relatedNodeIds || [])
  );

  for (const thread of threads) {
    if ((thread.warmth || 0) < warmthThreshold) continue;
    if (thread.status === 'resolved') continue;
    if (thread.resolved) continue;

    // Check last touched time
    const lastTouched = thread.lastTouched ? new Date(thread.lastTouched).getTime() : 0;
    if (lastTouched > 0 && (now - lastTouched) < fortyEightHours) continue;

    const threadId = thread.id || thread.thoughtId;
    if (alreadyOpenIds.has(threadId)) continue;

    const title = thread.title || threadId || 'unknown thread';
    const warmthPct = Math.round((thread.warmth || 0) * 100);
    const staleHours = lastTouched > 0 ? Math.round((now - lastTouched) / 3600000) : null;
    const staleStr = staleHours ? `${staleHours} hours` : 'an unknown amount of time';

    candidates.push({
      type: 'question',
      anomalyType: 'warmth-without-resolution',
      question: `What would it take to resolve the "${title.slice(0, 60)}" thread?`,
      context: `This reasoning thread has ${warmthPct}% warmth — it's staying alive — but hasn't had an update in ${staleStr}. ` +
               `High warmth without movement usually means the thread is waiting for something. What?`,
      relatedNodeIds: threadId ? [threadId] : [],
      pursuitCount: 0,
      status: 'open',
      maturity: 'seed'
    });

    if (candidates.length >= 2) break; // cap at 2
  }

  return candidates;
}

// ── Orphan Pattern Detection ─────────────────────────────────

function _detectOrphanPatterns(kg, existing) {
  const candidates = [];

  // Find hypothesis nodes that appear multiple times (similar topics)
  // and aren't connected to any goal/project node
  const hypothesisNodes = [...kg.nodes.values()].filter(n => n.type === 'hypothesis');
  if (hypothesisNodes.length < 3) return [];

  // Group by rough topic (first 5 meaningful words of title)
  const topicGroups = new Map();
  for (const node of hypothesisNodes) {
    const title = (node.title || '').toLowerCase();
    // Fingerprint: first 4 words, stripped
    const words = title.split(/\s+/).filter(w => w.length > 3).slice(0, 4).join('-');
    if (!words) continue;

    if (!topicGroups.has(words)) topicGroups.set(words, []);
    topicGroups.get(words).push(node);
  }

  // Find groups with 3+ nodes
  const alreadyOpenIds = new Set(
    existing
      .filter(q => q.anomalyType === 'orphan-pattern')
      .flatMap(q => q.relatedNodeIds || [])
  );

  // Also check: hypothesis nodes connected to project/goal nodes
  const goalNodeIds = new Set(
    [...kg.nodes.values()]
      .filter(n => PROJECT_TYPES.has(n.type) || _isProjectHint(n))
      .map(n => n.id)
  );

  for (const [topic, nodes] of topicGroups) {
    if (nodes.length < 3) continue;

    // Check if any of these nodes are connected to a goal/project
    let connectedToGoal = false;
    for (const node of nodes) {
      const neighbors = _getNeighborIds(kg, node.id);
      if (neighbors.some(nid => goalNodeIds.has(nid))) {
        connectedToGoal = true;
        break;
      }
    }

    if (connectedToGoal) continue;

    // Don't re-raise if already an open question about these nodes
    const nodeIds = nodes.map(n => n.id);
    if (nodeIds.some(id => alreadyOpenIds.has(id))) continue;

    const sampleTitle = nodes[0].title || topic;
    candidates.push({
      type: 'question',
      anomalyType: 'orphan-pattern',
      question: `I keep seeing hypotheses about "${sampleTitle.slice(0, 60)}" — what project does this belong to?`,
      context: `${nodes.length} hypothesis nodes share this topic cluster but none are connected to any goal or project node. ` +
               `The graph keeps generating ideas in this area without anchoring them to anything purposeful.`,
      relatedNodeIds: nodeIds.slice(0, 10),
      pursuitCount: 0,
      status: 'open',
      maturity: 'seed'
    });

    if (candidates.length >= 2) break; // cap at 2
  }

  return candidates;
}

// ── Gap Detection ────────────────────────────────────────────

function _detectGaps(kg, existing) {
  const candidates = [];

  // Find nodes that look like projects/goals but have no connections to reasoning types
  const alreadyOpenIds = new Set(
    existing
      .filter(q => q.anomalyType === 'gap')
      .flatMap(q => q.relatedNodeIds || [])
  );

  for (const node of kg.nodes.values()) {
    if (!PROJECT_TYPES.has(node.type) && !_isProjectHint(node)) continue;
    if (alreadyOpenIds.has(node.id)) continue;

    const neighbors = _getNeighborIds(kg, node.id);
    if (neighbors.length === 0) continue; // pure orphan — not a gap question, different problem

    // Check if any neighbors are reasoning-type nodes
    const hasReasoningNeighbor = neighbors.some(nid => {
      const n = kg.nodes.get(nid);
      return n && REASONING_TYPES.has(n.type);
    });

    if (hasReasoningNeighbor) continue;

    const title = (node.title || node.id).slice(0, 60);
    candidates.push({
      type: 'question',
      anomalyType: 'gap',
      question: `What do I actually think about "${title}"?`,
      context: `This node exists in the graph with ${neighbors.length} connection(s), but none of them are reflections, ` +
               `hypotheses, observations, or insights. I know this exists but haven't reasoned about it deeply.`,
      relatedNodeIds: [node.id],
      pursuitCount: 0,
      status: 'open',
      maturity: 'seed'
    });

    if (candidates.length >= 2) break; // cap at 2
  }

  return candidates;
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Extract the set of neighbor node IDs for a given node (both directions).
 */
function _getNeighborIds(kg, nodeId) {
  const ids = [];
  for (const eid of (kg.adjacency.get(nodeId) || new Set())) {
    const e = kg.edges.get(eid);
    if (e) ids.push(e.to);
  }
  for (const eid of (kg.reverseAdj.get(nodeId) || new Set())) {
    const e = kg.edges.get(eid);
    if (e) ids.push(e.from);
  }
  return ids;
}

/**
 * Check if a node looks like a project node based on its tags or title keywords.
 */
function _isProjectHint(node) {
  const tags = node.metadata?.tags || [];
  if (tags.some(t => PROJECT_TAG_HINTS.includes(t.toLowerCase()))) return true;
  const title = (node.title || '').toLowerCase();
  return PROJECT_TAG_HINTS.some(hint => title.includes(hint));
}

/**
 * Build a set of "node pair" keys from existing open convergence questions,
 * so we don't re-generate the same question.
 * Returns Set of "idA::idB" strings (sorted).
 */
function _existingQuestionNodePairs(existing, anomalyType) {
  const pairs = [];
  for (const q of existing) {
    if (q.anomalyType !== anomalyType) continue;
    const ids = (q.relatedNodeIds || []).slice().sort();
    if (ids.length >= 2) {
      pairs.push(ids[0] + '::' + ids[1]);
    }
  }
  return pairs;
}

module.exports = { detect };
