// ============================================================
// SOMA — Sleep Mode
// Lightweight reasoning thread continuity between sessions.
//
// Analogous to how sleep maintains continuity of self in humans.
// No LLM calls. No API calls. No thought creation. No KG writes.
// Pure computation: read files, match tags, track warmth, write state.
//
// Usage:
//   node src/layers/sleep.js              # Run one sleep cycle
//   node src/layers/sleep.js --status     # Print current sleep state
//   node src/layers/sleep.js --reset      # Clear state and start fresh
// ============================================================

const fs = require('fs');
const path = require('path');

let _config = {};
try { _config = require('../../soma.config.js'); } catch (_) {}
const DATA_DIR = process.env.SOMA_DATA || _config.dataDir || path.join(__dirname, '../../data');
const SOMA_HOME = process.env.SOMA_HOME || _config.home || path.join(__dirname, '../..');
const SLEEP_STATE_FILE = path.join(DATA_DIR, 'sleep_state.json');
const DEPARTURE_FILE = path.join(SOMA_HOME, 'departure.md');
const THOUGHTSTREAM_FILE = path.join(DATA_DIR, 'thoughtstream.json');
const KG_FILE = path.join(DATA_DIR, 'knowledge_graph.json');
const NARRATIVES_FILE = path.join(DATA_DIR, 'session_narratives.json');

// ── Constants ─────────────────────────────────────────────────
const WARMTH_INITIAL = 1.0;
const WARMTH_BOOST = 0.1;
const WARMTH_FADE_THRESHOLD = 0.2;
const JOURNAL_MAX = 20;
const AUTO_DISCOVER_MAX = 3;        // Max new threads to auto-discover per cycle
const SESSION_ACTIVITY_BOOST = 0.15; // Warmth boost when session activity detected

// ── Exponential Decay Constants ───────────────────────────────
// Half-life of 24 hours: after 24h of no activity, warmth halves.
// After 48h -> 25%, 72h -> 12.5%. Much gentler than the old linear
// decay (0.05/cycle) which killed threads in ~5 hours.
const DECAY_HALF_LIFE_HOURS = 24;

// ── Connection Discovery Constants ────────────────────────────
// Relevance scoring replaces the old hard 2-tag minimum.
// Connections are scored by tag overlap + title keyword matching.
// Only connections with total relevance >= 0.4 are created.
const RELEVANCE_1_TAG = 0.3;
const RELEVANCE_2_TAGS = 0.6;
const RELEVANCE_3_PLUS_TAGS = 0.9;
const RELEVANCE_TITLE_KEYWORD = 0.2;  // Additive with tag relevance
const RELEVANCE_THRESHOLD = 0.4;      // Minimum relevance to create a connection
const TITLE_KEYWORD_MIN_LENGTH = 4;   // Only match title words longer than this

// ── Re-activation Constants ───────────────────────────────────
// Faded threads can come back to life if new activity matches them.
const REACTIVATION_WARMTH = 0.5;      // Warmth to set on re-activation (active threshold)
const REACTIVATION_TAG_OVERLAP = 2;   // Tags a new thought must share to re-activate a faded thread
const REACTIVATION_MAX_CHECK = 20;    // Max faded threads to check per cycle (keep it fast)

// ── File I/O Helpers ──────────────────────────────────────────

function readJSON(filepath) {
  try {
    if (!fs.existsSync(filepath)) return null;
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJSON(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

function readText(filepath) {
  try {
    if (!fs.existsSync(filepath)) return null;
    return fs.readFileSync(filepath, 'utf8');
  } catch {
    return null;
  }
}

// ── Load Sleep State ──────────────────────────────────────────

function loadSleepState() {
  const data = readJSON(SLEEP_STATE_FILE);
  if (!data) {
    return {
      lastCycle: null,
      lastCycleTime: null,   // ISO timestamp for exponential decay elapsed-time calculation
      cycleCount: 0,
      activeThreads: [],
      pendingNarratives: [],
      journal: [],
      processedNarrativeIds: []
    };
  }
  // Backward compat: ensure lastCycleTime exists (fall back to lastCycle)
  if (!data.lastCycleTime && data.lastCycle) {
    data.lastCycleTime = data.lastCycle;
  }
  return data;
}

// ── Parse Departure.md ────────────────────────────────────────
// Extracts thread titles and thought IDs from departure.md.
//
// Supports two formats:
// 1. Legacy: "## Active Threads" section with ### sub-headers containing
//    backtick-wrapped thought IDs. Used by early departure records.
// 2. Current: Stance/Tensions/Surprises format. The departure format
//    evolved away from explicit thread sections, so we scan the entire
//    document for t-XXXXX patterns (with or without backticks).
//
// Strategy: try legacy first. If it finds threads, use them.
// Otherwise fall back to whole-document ID extraction.

function parseDeparture(text) {
  if (!text) return [];

  const threads = [];

  // ── Strategy 1: Legacy "## Active Threads" section ──────────
  const activeThreadsMatch = text.match(/## Active Threads\s*\n([\s\S]*?)(?=\n## [^#]|$)/);
  if (activeThreadsMatch) {
    const section = activeThreadsMatch[1];
    const threadBlocks = section.split(/(?=### )/);

    for (const block of threadBlocks) {
      if (!block.trim()) continue;

      const titleMatch = block.match(/^###\s+(.+?)(?:\s*\[.*?\])?\s*$/m);
      if (!titleMatch) continue;

      const title = titleMatch[1].trim();
      const thoughtIds = [];
      const idMatches = block.matchAll(/`(t-\d+)`/g);
      for (const m of idMatches) {
        if (!thoughtIds.includes(m[1])) {
          thoughtIds.push(m[1]);
        }
      }

      if (thoughtIds.length > 0) {
        threads.push({ title, thoughtIds });
      }
    }

    // If legacy format found threads, use them
    if (threads.length > 0) return threads;
  }

  // ── Strategy 2: Extract thought IDs from anywhere in departure.md ──
  // The current Stance/Tensions/Surprises format may reference thought IDs
  // inline. Scan the entire document for t-XXXXX patterns.
  const allIds = new Set();

  // Match t-XXXXX with or without backticks, anywhere in the document
  const globalIdMatches = text.matchAll(/`?(t-\d+)`?/g);
  for (const m of globalIdMatches) {
    allIds.add(m[1]);
  }

  // Also scan named sections explicitly for belt-and-suspenders coverage
  const sectionPatterns = [
    /## Stance\s*\n([\s\S]*?)(?=\n## |$)/,
    /## Tensions\s*\n([\s\S]*?)(?=\n## |$)/,
    /## Surprises\s*\n([\s\S]*?)(?=\n## |$)/,
    /## For the Next Instance\s*\n([\s\S]*?)(?=\n## |$)/
  ];

  for (const pattern of sectionPatterns) {
    const match = text.match(pattern);
    if (match) {
      const sectionIds = match[1].matchAll(/(t-\d+)/g);
      for (const m of sectionIds) {
        allIds.add(m[1]);
      }
    }
  }

  // Each discovered ID becomes its own thread entry.
  // Title is set to the ID for now; holdThreads will resolve it from
  // the thoughtstream if the thought exists.
  for (const id of allIds) {
    threads.push({ title: id, thoughtIds: [id] });
  }

  return threads;
}

// ── Load Thoughtstream ────────────────────────────────────────

function loadThoughtstream() {
  const data = readJSON(THOUGHTSTREAM_FILE);
  if (!data) return new Map();

  const thoughts = Array.isArray(data) ? data : (data.thoughts || []);
  const map = new Map();
  for (const t of thoughts) {
    if (t.id) map.set(t.id, t);
  }
  return map;
}

// ── Load Knowledge Graph (read-only) ──────────────────────────
// Returns { nodes: Map<id, node>, edges: Array<edge> }

function loadKG() {
  const data = readJSON(KG_FILE);
  if (!data) return { nodes: new Map(), edges: [] };

  const nodes = new Map();
  for (const node of (data.nodes || [])) {
    if (node.id) nodes.set(node.id, node);
  }

  return { nodes, edges: data.edges || [] };
}

// ── Load Narratives ───────────────────────────────────────────

function loadNarratives() {
  const data = readJSON(NARRATIVES_FILE);
  if (!data) return [];
  return data.narratives || [];
}

// ── Tag Extraction ────────────────────────────────────────────

function getNodeTags(node) {
  if (!node) return [];
  // KG nodes have metadata.tags
  if (node.metadata && Array.isArray(node.metadata.tags)) return node.metadata.tags;
  // Thoughtstream thoughts have top-level tags
  if (Array.isArray(node.tags)) return node.tags;
  return [];
}

// ── Get Connected Node IDs ────────────────────────────────────
// From a thought's connections array (thoughtstream format)

function getThoughtConnectionIds(thought) {
  if (!thought || !Array.isArray(thought.connections)) return [];
  return thought.connections
    .map(c => c.targetId || c.id)
    .filter(Boolean);
}

// ── Date Comparison Helper ────────────────────────────────────
// Thoughtstream uses date strings ("2026-03-29"), lastCycle is ISO.
// Returns true if the thought date is on or after the reference ISO date.

function isDateOnOrAfter(thoughtDate, isoReference) {
  if (!thoughtDate || !isoReference) return false;
  // Extract YYYY-MM-DD from the ISO reference
  const refDate = isoReference.split('T')[0];
  return thoughtDate >= refDate;
}

// ── Extract Title Keywords ────────────────────────────────────
// Splits a title into meaningful words (> TITLE_KEYWORD_MIN_LENGTH chars),
// lowercased, with common stop words removed.

function extractTitleKeywords(title) {
  if (!title) return [];
  const stopWords = new Set([
    'this', 'that', 'with', 'from', 'into', 'about', 'which', 'when',
    'where', 'what', 'there', 'their', 'these', 'those', 'been', 'being',
    'have', 'were', 'they', 'than', 'them', 'then', 'some', 'could',
    'would', 'should', 'will', 'just', 'also', 'more', 'very', 'much',
    'does', 'doing', 'done', 'already', 'first', 'untitled'
  ]);

  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')     // strip punctuation
    .split(/\s+/)
    .filter(w => w.length > TITLE_KEYWORD_MIN_LENGTH && !stopWords.has(w));
}

// ── Compute Connection Relevance ──────────────────────────────
// Scores a potential connection based on shared tags + title keyword overlap.
// Returns { relevance, sharedTags, titleKeywordMatches }.

function computeRelevance(threadTags, threadTitleKeywords, nodeTags, nodeTitle) {
  // Tag overlap scoring
  const threadTagSet = new Set(threadTags.map(t => t.toLowerCase()));
  const nodeTagsLower = nodeTags.map(t => t.toLowerCase());
  const sharedTags = nodeTagsLower.filter(t => threadTagSet.has(t));

  let tagRelevance = 0;
  if (sharedTags.length >= 3) tagRelevance = RELEVANCE_3_PLUS_TAGS;
  else if (sharedTags.length === 2) tagRelevance = RELEVANCE_2_TAGS;
  else if (sharedTags.length === 1) tagRelevance = RELEVANCE_1_TAG;

  // Title keyword matching: check if any thread title keyword appears
  // in the KG node's title keywords (exact match or substring for words >= 5 chars)
  const nodeKeywords = extractTitleKeywords(nodeTitle);
  const titleKeywordMatches = [];
  for (const kw of threadTitleKeywords) {
    for (const nk of nodeKeywords) {
      if (kw === nk || (kw.length >= 5 && nk.length >= 5 && (kw.includes(nk) || nk.includes(kw)))) {
        if (!titleKeywordMatches.includes(kw)) {
          titleKeywordMatches.push(kw);
        }
      }
    }
  }

  const titleRelevance = titleKeywordMatches.length > 0 ? RELEVANCE_TITLE_KEYWORD : 0;

  return {
    relevance: tagRelevance + titleRelevance,
    sharedTags,
    titleKeywordMatches
  };
}

// ── Find KG Nodes by Relevance ────────────────────────────────
// Replaces the old findKGNodesByTagOverlap. Now scores connections via
// tag overlap + title keyword matching, and only returns nodes meeting
// the relevance threshold (>= 0.4).

function findKGNodesByRelevance(kgNodes, targetTags, threadTitle, excludeIds) {
  const results = [];
  const threadTitleKeywords = extractTitleKeywords(threadTitle);

  // Need at least some tags or keywords to search with
  if (targetTags.length === 0 && threadTitleKeywords.length === 0) return results;

  for (const [id, node] of kgNodes) {
    if (excludeIds.has(id)) continue;

    const nodeTags = getNodeTags(node);
    const nodeTitle = node.title || '';

    const { relevance, sharedTags, titleKeywordMatches } = computeRelevance(
      targetTags, threadTitleKeywords, nodeTags, nodeTitle
    );

    if (relevance >= RELEVANCE_THRESHOLD) {
      results.push({
        nodeId: id,
        title: nodeTitle || '(untitled)',
        sharedTags,
        titleKeywordMatches,
        relevance
      });
    }
  }

  // Sort by relevance descending so best matches come first
  results.sort((a, b) => b.relevance - a.relevance);

  return results;
}

// ── Exponential Warmth Decay ──────────────────────────────────
// Computes warmth after exponential decay with a 24-hour half-life.
//   warmth *= 0.5^(elapsedHours / 24)
// After 24h: 50%, 48h: 25%, 72h: 12.5%.
// Much gentler than the old linear decay (0.05 per 15-min cycle = dead in ~5h).

function decayWarmth(currentWarmth, lastCycleTimeISO) {
  if (!lastCycleTimeISO) {
    // No previous cycle time recorded — apply a tiny default decay
    // equivalent to about 15 minutes of exponential decay
    return currentWarmth * Math.pow(0.5, 0.25 / DECAY_HALF_LIFE_HOURS);
  }

  const now = Date.now();
  const lastTime = new Date(lastCycleTimeISO).getTime();
  const elapsedMs = Math.max(0, now - lastTime);
  const elapsedHours = elapsedMs / (1000 * 60 * 60);

  return currentWarmth * Math.pow(0.5, elapsedHours / DECAY_HALF_LIFE_HOURS);
}

// ── Re-activate Faded Threads ─────────────────────────────────
// Checks faded threads against recent activity. A faded thread can
// come back to life if:
//   (a) A new thought (created since lastCycle) shares 2+ tags with it
//   (b) A currently active/fading thread has a connection pointing to
//       the faded thread's thought
//   (c) Session activity touches the faded thread's thought (handled
//       separately in holdThreads via the existing session-activity check)
//
// On re-activation: warmth is set to 0.5 (active threshold), status
// becomes "active", and a journal entry is logged. Capped at
// REACTIVATION_MAX_CHECK faded threads per cycle.

function checkFadedReactivation(state, thoughts, stateThreadMap) {
  const now = new Date().toISOString();
  const journalEntries = [];

  const fadedThreads = state.activeThreads.filter(t => t.status === 'faded');
  if (fadedThreads.length === 0) return journalEntries;

  // Collect new thoughts created since last cycle (for rule a)
  const newThoughts = [];
  if (state.lastCycle) {
    for (const [thoughtId, thought] of thoughts) {
      if (isDateOnOrAfter(thought.created, state.lastCycle)) {
        newThoughts.push({ id: thoughtId, thought });
      }
    }
  }

  // Collect all connection targets from active/fading threads (for rule b)
  const activeConnectionTargets = new Set();
  for (const [, thread] of stateThreadMap) {
    if (thread.status !== 'faded') {
      for (const conn of (thread.connections || [])) {
        activeConnectionTargets.add(conn.nodeId);
      }
    }
  }

  // Check faded threads (capped to keep it fast)
  const toCheck = fadedThreads.slice(0, REACTIVATION_MAX_CHECK);

  for (const fadedThread of toCheck) {
    let reactivated = false;
    let reason = '';

    // Get the faded thread's tags for comparison
    const fadedThought = thoughts.get(fadedThread.thoughtId);
    const fadedTags = fadedThought ? getNodeTags(fadedThought).map(t => t.toLowerCase()) : [];
    const fadedTagSet = new Set(fadedTags);

    // Rule (a): New thought shares 2+ tags with faded thread
    if (!reactivated && fadedTagSet.size > 0) {
      for (const { id: newId, thought: newThought } of newThoughts) {
        const newTags = getNodeTags(newThought).map(t => t.toLowerCase());
        const overlap = newTags.filter(t => fadedTagSet.has(t));

        if (overlap.length >= REACTIVATION_TAG_OVERLAP) {
          reactivated = true;
          reason = `new thought '${newThought.title || newId}' shares tags [${overlap.join(', ')}]`;
          break;
        }
      }
    }

    // Rule (b): An active thread's connection points to this faded thread's thought
    if (!reactivated && activeConnectionTargets.has(fadedThread.thoughtId)) {
      reactivated = true;
      reason = 'active thread found connection to this thought';
    }

    if (reactivated) {
      const threadInMap = stateThreadMap.get(fadedThread.id);
      if (threadInMap) {
        threadInMap.warmth = REACTIVATION_WARMTH;
        threadInMap.status = 'active';
        threadInMap.lastTouched = now;

        journalEntries.push({
          time: now,
          entry: `Thread '${fadedThread.title}' RE-ACTIVATED (was faded) — ${reason}`
        });
      }
    }
  }

  return journalEntries;
}

// ── Thread Holding ────────────────────────────────────────────
// Core sleep function: maintain warmth of reasoning threads.

function holdThreads(state, departureThreads, thoughts, kg) {
  const now = new Date().toISOString();
  let newConnections = 0;
  const journalEntries = [];

  // Build the set of active threads from departure.md
  // If departure has new threads not in state, add them
  // If state has threads not in departure, keep them (they decay naturally)

  const stateThreadMap = new Map();
  for (const thread of state.activeThreads) {
    stateThreadMap.set(thread.id, thread);
  }

  // Merge departure threads into state
  for (const depThread of departureThreads) {
    // Use the first thought ID as the thread's primary ID
    const primaryId = depThread.thoughtIds[0];

    if (!stateThreadMap.has(primaryId)) {
      // New thread from departure — initialize
      stateThreadMap.set(primaryId, {
        id: primaryId,
        title: depThread.title,
        thoughtId: primaryId,
        warmth: WARMTH_INITIAL,
        status: 'active',
        connections: [],
        lastTouched: now
      });
    } else {
      // Existing thread — update title from latest departure,
      // but only if departure provided a real title (not just an ID
      // from the flexible parser)
      const existing = stateThreadMap.get(primaryId);
      if (depThread.title && !depThread.title.match(/^t-\d+$/)) {
        existing.title = depThread.title;
      }
    }
  }

  // ── Re-activate faded threads before main processing ────────
  // This runs before decay so re-activated threads get a full active cycle.
  const reactivationEntries = checkFadedReactivation(state, thoughts, stateThreadMap);
  journalEntries.push(...reactivationEntries);

  // Process each thread
  for (const [threadId, thread] of stateThreadMap) {
    // Faded threads get a lightweight connection scan but no decay processing.
    // If they find a connection, they re-activate (warmth -> 0.5, status -> active).
    const isFaded = thread.status === 'faded';
    if (isFaded) {
      // Lightweight scan: check if KG has nodes matching this thread's tags
      const fadedThought = thoughts.get(thread.thoughtId);
      if (fadedThought) {
        const fadedTags = [];
        for (const tag of getNodeTags(fadedThought)) fadedTags.push(tag);
        const kgNode = kg.nodes.get(thread.thoughtId);
        if (kgNode) {
          for (const tag of getNodeTags(kgNode)) {
            if (!fadedTags.includes(tag)) fadedTags.push(tag);
          }
        }
        const excludeIds = new Set([thread.thoughtId]);
        for (const conn of thread.connections) excludeIds.add(conn.nodeId);
        for (const connId of getThoughtConnectionIds(fadedThought)) excludeIds.add(connId);

        const matches = findKGNodesByRelevance(kg.nodes, fadedTags, thread.title, excludeIds);
        if (matches.length > 0) {
          // Found connections — re-activate this thread
          const best = matches.slice(0, 3); // Cap at 3 connections per re-activation
          for (const match of best) {
            thread.connections.push({
              nodeId: match.nodeId,
              title: match.title,
              sharedTags: match.sharedTags,
              titleKeywordMatches: match.titleKeywordMatches,
              relevance: match.relevance,
              foundAt: now
            });
            newConnections++;
            journalEntries.push({
              time: now,
              entry: `RE-ACTIVATED '${thread.title}' via KG connection '${match.title}' (relevance: ${match.relevance.toFixed(2)}, tags: [${match.sharedTags.join(', ')}])`
            });
          }
          thread.warmth = REACTIVATION_WARMTH;
          thread.status = 'active';
          thread.lastTouched = now;
        }
      }
      continue; // Skip decay/session-activity processing for faded threads
    }

    // Check for session activity on this thread's thoughts before decaying.
    // If the primary thought (or any thought connected to it) was updated
    // since lastCycle, boost warmth instead of decaying.
    let sessionActive = false;
    let activeThoughtId = null;

    if (state.lastCycle) {
      const primaryThought = thoughts.get(thread.thoughtId);
      if (primaryThought && isDateOnOrAfter(primaryThought.updated, state.lastCycle)) {
        sessionActive = true;
        activeThoughtId = thread.thoughtId;
      }

      // Also check connected thoughts
      if (!sessionActive && primaryThought) {
        for (const connId of getThoughtConnectionIds(primaryThought)) {
          const connThought = thoughts.get(connId);
          if (connThought && isDateOnOrAfter(connThought.updated, state.lastCycle)) {
            sessionActive = true;
            activeThoughtId = connId;
            break;
          }
        }
      }
    }

    if (sessionActive) {
      // Boost warmth — session activity is keeping this thread alive
      thread.warmth = Math.min(WARMTH_INITIAL, thread.warmth + SESSION_ACTIVITY_BOOST);
      thread.lastTouched = now;
      journalEntries.push({
        time: now,
        entry: `Thread '${thread.title}' warmed by session activity (thought ${activeThoughtId} updated)`
      });
    } else {
      // ── Exponential decay ─────────────────────────────────
      // Uses time elapsed since last cycle for accurate decay regardless
      // of cycle frequency. Half-life: 24 hours.
      thread.warmth = Math.max(0, decayWarmth(thread.warmth, state.lastCycleTime));
    }

    // Collect tags for this thread from the thought + all associated thoughts
    const threadTags = new Set();
    const excludeIds = new Set();

    // Add the primary thought's tags
    const primaryThoughtForTags = thoughts.get(thread.thoughtId);
    if (primaryThoughtForTags) {
      for (const tag of getNodeTags(primaryThoughtForTags)) {
        threadTags.add(tag);
      }
      excludeIds.add(thread.thoughtId);

      // Add connected thought IDs to exclusion set
      for (const connId of getThoughtConnectionIds(primaryThoughtForTags)) {
        excludeIds.add(connId);
      }
    }

    // Also check the KG node for the same ID (may have different/additional tags)
    const kgNode = kg.nodes.get(thread.thoughtId);
    if (kgNode) {
      for (const tag of getNodeTags(kgNode)) {
        threadTags.add(tag);
      }
    }

    // Exclude already-found connections
    for (const conn of thread.connections) {
      excludeIds.add(conn.nodeId);
    }

    // ── Improved connection discovery ───────────────────────
    // Search KG for nodes meeting the relevance threshold via tag overlap
    // and/or title keyword matching. Stores relevance scores on connections.
    const matches = findKGNodesByRelevance(
      kg.nodes,
      [...threadTags],
      thread.title,
      excludeIds
    );

    // Record genuine new connections
    for (const match of matches) {
      thread.connections.push({
        nodeId: match.nodeId,
        title: match.title,
        sharedTags: match.sharedTags,
        titleKeywordMatches: match.titleKeywordMatches,
        relevance: match.relevance,
        foundAt: now
      });

      // Boost warmth for finding a connection
      thread.warmth = Math.min(WARMTH_INITIAL, thread.warmth + WARMTH_BOOST);
      thread.lastTouched = now;
      newConnections++;

      // Journal entry with relevance details
      const matchParts = [];
      if (match.sharedTags.length > 0) matchParts.push(`tags [${match.sharedTags.join(', ')}]`);
      if (match.titleKeywordMatches.length > 0) matchParts.push(`title keywords [${match.titleKeywordMatches.join(', ')}]`);
      journalEntries.push({
        time: now,
        entry: `Thread '${thread.title}' touched KG node '${match.title}' (relevance ${match.relevance.toFixed(2)}) via ${matchParts.join(' + ')}`
      });
    }

    // Update status based on warmth
    if (thread.warmth < WARMTH_FADE_THRESHOLD) {
      thread.status = 'faded';
    } else if (thread.warmth < 0.5) {
      thread.status = 'fading';
    } else {
      thread.status = 'active';
    }
  }

  // ── Auto-discover new threads from session activity ──────────
  // Scan thoughtstream for thoughts created since lastCycle that connect
  // to any existing active thread's thought. Cap at AUTO_DISCOVER_MAX.
  if (state.lastCycle) {
    // Build set of all thought IDs already tracked as threads
    const trackedThoughtIds = new Set();
    for (const [, thread] of stateThreadMap) {
      trackedThoughtIds.add(thread.thoughtId);
    }

    // Build set of thought IDs belonging to active threads (for connection matching)
    const activeThreadThoughtIds = new Set();
    for (const [, thread] of stateThreadMap) {
      if (thread.status !== 'faded') {
        activeThreadThoughtIds.add(thread.thoughtId);
        // Also include connected thoughts from the thread's primary thought
        const pt = thoughts.get(thread.thoughtId);
        if (pt) {
          for (const connId of getThoughtConnectionIds(pt)) {
            activeThreadThoughtIds.add(connId);
          }
        }
      }
    }

    // Find new thoughts created since lastCycle with connections to active threads
    const candidates = [];
    for (const [thoughtId, thought] of thoughts) {
      // Must be created since lastCycle
      if (!isDateOnOrAfter(thought.created, state.lastCycle)) continue;
      // Must not already be tracked as a thread
      if (trackedThoughtIds.has(thoughtId)) continue;

      // Count connections to existing active thread thoughts
      const connIds = getThoughtConnectionIds(thought);
      let connectionCount = 0;
      let connectedToThread = null;

      for (const connId of connIds) {
        if (activeThreadThoughtIds.has(connId)) {
          connectionCount++;
          // Track which thread this connects to (for the journal entry)
          if (!connectedToThread) {
            for (const [, thread] of stateThreadMap) {
              if (thread.thoughtId === connId || (thoughts.get(thread.thoughtId) &&
                  getThoughtConnectionIds(thoughts.get(thread.thoughtId)).includes(connId))) {
                connectedToThread = thread.title;
                break;
              }
            }
            // Fallback: use the connected thought's title
            if (!connectedToThread) {
              const ct = thoughts.get(connId);
              connectedToThread = ct ? (ct.title || connId) : connId;
            }
          }
        }
      }

      if (connectionCount > 0) {
        candidates.push({
          thoughtId,
          thought,
          connectionCount,
          connectedToThread
        });
      }
    }

    // Sort by connection count (most connected first), take top AUTO_DISCOVER_MAX
    candidates.sort((a, b) => b.connectionCount - a.connectionCount);
    const toAdd = candidates.slice(0, AUTO_DISCOVER_MAX);

    for (const candidate of toAdd) {
      stateThreadMap.set(candidate.thoughtId, {
        id: candidate.thoughtId,
        title: candidate.thought.title || '(untitled)',
        thoughtId: candidate.thoughtId,
        warmth: WARMTH_INITIAL,
        status: 'active',
        connections: [],
        lastTouched: now
      });

      journalEntries.push({
        time: now,
        entry: `New thread discovered: '${candidate.thought.title || '(untitled)'}' (connected to '${candidate.connectedToThread}')`
      });
    }
  }

  // Write back to state
  state.activeThreads = [...stateThreadMap.values()];

  return { newConnections, journalEntries };
}

// ── Consolidation (lightweight) ───────────────────────────────
// Check for unprocessed narratives, extract metadata, note thread overlap.

function consolidateNarratives(state, narratives, thoughts) {
  const processed = new Set(state.processedNarrativeIds || []);
  const newNarratives = narratives.filter(n => n.id && !processed.has(n.id));

  if (newNarratives.length === 0) return 0;

  // Build tag sets for active threads (for overlap detection)
  const threadTagSets = [];
  for (const thread of state.activeThreads) {
    const thought = thoughts.get(thread.thoughtId);
    const tags = thought ? getNodeTags(thought).map(t => t.toLowerCase()) : [];
    threadTagSets.push({ threadId: thread.id, tags: new Set(tags) });
  }

  for (const narrative of newNarratives) {
    const narrativeTags = (narrative.tags || []).map(t => t.toLowerCase());

    // Find which active threads this narrative touches
    const threadOverlap = [];
    for (const { threadId, tags } of threadTagSets) {
      const overlap = narrativeTags.filter(t => tags.has(t));
      if (overlap.length >= 1) {
        threadOverlap.push(threadId);
      }
    }

    // Record as pending narrative (metadata only — no KG writes)
    state.pendingNarratives.push({
      id: narrative.id,
      title: narrative.title || '(untitled)',
      project: narrative.project || null,
      tags: narrative.tags || [],
      decisions: narrative.decisions || [],
      threadOverlap
    });

    // Mark as processed
    processed.add(narrative.id);
  }

  state.processedNarrativeIds = [...processed];

  return newNarratives.length;
}

// ── Sleep Cycle ───────────────────────────────────────────────

function runSleepCycle() {
  const state = loadSleepState();

  // Load data sources
  const departureText = readText(DEPARTURE_FILE);
  if (!departureText) {
    console.log('[Sleep] No departure.md found — nothing to hold. Exiting.');
    return;
  }

  const departureThreads = parseDeparture(departureText);
  if (departureThreads.length === 0 && state.activeThreads.length === 0) {
    console.log('[Sleep] No active threads in departure.md and no existing state. Exiting.');
    return;
  }

  const thoughts = loadThoughtstream();
  const kg = loadKG();

  // Resolve titles for departure threads that only have bare IDs
  // (from the flexible parser that extracts t-XXXXX refs without context)
  for (const dt of departureThreads) {
    if (dt.title && dt.title.match(/^t-\d+$/)) {
      const thought = thoughts.get(dt.title);
      if (thought && thought.title) {
        dt.title = thought.title;
      }
    }
  }

  if (kg.nodes.size === 0) {
    console.log('[Sleep] Knowledge graph is empty or missing — skipping KG search.');
  }

  // 1. Thread holding (includes re-activation check + exponential decay + connection discovery)
  const { newConnections, journalEntries } = holdThreads(state, departureThreads, thoughts, kg);

  // 2. Narrative consolidation
  const narratives = loadNarratives();
  const newNarrativeCount = consolidateNarratives(state, narratives, thoughts);

  // 3. Update journal (prepend new entries, cap at max)
  state.journal = [...journalEntries, ...state.journal].slice(0, JOURNAL_MAX);

  // 4. Update cycle metadata
  state.cycleCount = (state.cycleCount || 0) + 1;
  const nowISO = new Date().toISOString();
  state.lastCycle = nowISO;
  state.lastCycleTime = nowISO;  // Explicit timestamp for exponential decay calculation

  // 5. Write state
  writeJSON(SLEEP_STATE_FILE, state);

  // 6. Summary
  const activeCount = state.activeThreads.filter(t => t.status === 'active').length;
  const fadingCount = state.activeThreads.filter(t => t.status === 'fading').length;
  const fadedCount = state.activeThreads.filter(t => t.status === 'faded').length;
  const reactivatedCount = journalEntries.filter(e => e.entry.includes('RE-ACTIVATED')).length;

  const parts = [];
  parts.push(`${activeCount} active`);
  if (fadingCount > 0) parts.push(`${fadingCount} fading`);
  if (fadedCount > 0) parts.push(`${fadedCount} faded`);
  if (reactivatedCount > 0) parts.push(`${reactivatedCount} re-activated`);

  console.log(`Sleep cycle ${state.cycleCount}: ${parts.join(', ')} thread(s), ${newConnections} new connection(s), ${newNarrativeCount} new narrative(s)`);
}

// ── Status ────────────────────────────────────────────────────

function printStatus() {
  const state = loadSleepState();

  if (!state.lastCycle) {
    console.log('Sleep: No cycles run yet.');
    return;
  }

  console.log(`Sleep State — ${state.cycleCount} cycles, last: ${state.lastCycle}`);
  console.log('');

  if (state.activeThreads.length === 0) {
    console.log('  No active threads.');
  } else {
    console.log('  Threads:');
    for (const thread of state.activeThreads) {
      const warmthBar = '█'.repeat(Math.round(thread.warmth * 10)) + '░'.repeat(10 - Math.round(thread.warmth * 10));
      console.log(`    [${thread.status.padEnd(7)}] ${warmthBar} ${thread.warmth.toFixed(2)} | ${thread.title}`);
      if (thread.connections.length > 0) {
        const latestConn = thread.connections[thread.connections.length - 1];
        const relStr = latestConn.relevance != null ? ` (rel: ${latestConn.relevance.toFixed(2)})` : '';
        console.log(`             ${thread.connections.length} connection(s), latest: ${latestConn.title}${relStr}`);
      }
    }
  }

  if (state.journal.length > 0) {
    console.log('');
    console.log('  Recent journal:');
    for (const entry of state.journal.slice(0, 5)) {
      const time = entry.time.split('T')[0];
      console.log(`    [${time}] ${entry.entry}`);
    }
    if (state.journal.length > 5) {
      console.log(`    ... and ${state.journal.length - 5} more`);
    }
  }

  if (state.pendingNarratives.length > 0) {
    console.log('');
    console.log(`  Pending narratives: ${state.pendingNarratives.length}`);
    for (const n of state.pendingNarratives.slice(-3)) {
      const overlap = n.threadOverlap.length > 0
        ? ` (touches ${n.threadOverlap.length} thread(s))`
        : '';
      console.log(`    - ${n.title}${overlap}`);
    }
  }
}

// ── Reset ─────────────────────────────────────────────────────

function resetState() {
  if (fs.existsSync(SLEEP_STATE_FILE)) {
    fs.unlinkSync(SLEEP_STATE_FILE);
    console.log('Sleep state cleared.');
  } else {
    console.log('No sleep state to clear.');
  }
}

// ── Exports ─────────────────────────────────────────────────

module.exports = { runSleepCycle, loadSleepState, printStatus, resetState };

// ── CLI ───────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--status')) {
    printStatus();
  } else if (args.includes('--reset')) {
    resetState();
  } else {
    runSleepCycle();
  }
}
