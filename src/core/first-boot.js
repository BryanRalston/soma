#!/usr/bin/env node
// ============================================================
// CORTEX CORE — First Boot (Deep Initialization)
// One-time script to connect the 730+ orphan nodes, run
// inference, detect patterns, and generate insights.
// ============================================================

const { boot } = require('./index');

const DIVIDER = '════════════════════════════════════════════════════════════════';

function elapsed(startMs) {
  const ms = Date.now() - startMs;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function firstBoot() {
  const t0 = Date.now();
  console.log(DIVIDER);
  console.log('  CORTEX CORE — FIRST BOOT (Deep Initialization)');
  console.log(DIVIDER);
  console.log(`  Started: ${new Date().toISOString()}\n`);

  // ── Boot engine normally ──────────────────────────────────
  console.log('[Boot] Initializing engine...');
  const engine = await boot({ verbose: true });
  const kg = engine.kg;

  const initialReport = kg.selfReport();
  console.log(`\n[Boot] Initial state:`);
  console.log(`  Nodes:   ${initialReport.totalNodes}`);
  console.log(`  Edges:   ${initialReport.totalEdges}`);
  console.log(`  Orphans: ${initialReport.orphanCount}`);
  console.log(`  Density: ${initialReport.density.toFixed(6)}`);
  console.log('');

  const stats = {
    phase1_connected: 0,
    phase1_skipped: 0,
    phase1b_connected: 0,
    phase2_inferences: 0,
    phase3_patterns: null,
    phase4_insights: 0
  };

  // ══════════════════════════════════════════════════════════
  // PHASE 1: Bulk Orphan Connection (TF-IDF Similarity)
  // ══════════════════════════════════════════════════════════
  try {
    const p1Start = Date.now();
    console.log(DIVIDER);
    console.log('  PHASE 1: Bulk Orphan Connection (TF-IDF)');
    console.log(DIVIDER);

    const orphans = kg.orphans();
    console.log(`  Orphans to process: ${orphans.length}`);
    console.log(`  Threshold: 0.15 | Max matches per orphan: 3 (best used)`);
    console.log('');

    // Force TF-IDF build once upfront for all nodes
    console.log('  Building TF-IDF index...');
    const tfidfStart = Date.now();
    kg._buildTFIDF();
    console.log(`  TF-IDF index built in ${elapsed(tfidfStart)} (${kg.nodes.size} documents)\n`);

    let connected = 0;
    let skipped = 0;

    for (let i = 0; i < orphans.length; i++) {
      const id = orphans[i];
      const node = kg.getNode(id);
      if (!node) { skipped++; continue; }

      const similar = kg.findSimilar(id, 0.15, 3);
      if (similar.length > 0) {
        // Connect to the best match
        const best = similar[0];
        kg.addEdge(id, best.id, 'relates-to', best.similarity);
        connected++;
      } else {
        skipped++;
      }

      // Progress report every 100 orphans
      if ((i + 1) % 100 === 0 || i === orphans.length - 1) {
        console.log(`  [${i + 1}/${orphans.length}] connected: ${connected}, no match: ${skipped} (${elapsed(p1Start)})`);
      }
    }

    stats.phase1_connected = connected;
    stats.phase1_skipped = skipped;

    console.log(`\n  Phase 1 complete: ${connected} edges added, ${skipped} orphans had no match above threshold`);
    console.log(`  Time: ${elapsed(p1Start)}`);
    console.log(`  New edge count: ${kg.edges.size}`);
    console.log(`  Remaining orphans: ${kg.orphans().length}\n`);
  } catch (err) {
    console.error(`  [Phase 1 ERROR] ${err.message}`);
    console.error(`  ${err.stack?.split('\n').slice(0, 3).join('\n  ')}\n`);
  }

  // ══════════════════════════════════════════════════════════
  // PHASE 1b: Tag-based Connection
  // ══════════════════════════════════════════════════════════
  try {
    const p1bStart = Date.now();
    console.log(DIVIDER);
    console.log('  PHASE 1b: Tag-based Connection');
    console.log(DIVIDER);

    // Group nodes by tags
    const tagGroups = new Map(); // tag -> [nodeId]
    for (const [id, node] of kg.nodes) {
      const tags = node.metadata?.tags || [];
      for (const tag of tags) {
        if (!tagGroups.has(tag)) tagGroups.set(tag, []);
        tagGroups.get(tag).push(id);
      }
    }

    console.log(`  Unique tags: ${tagGroups.size}`);

    // Track how many tag-based connections each node gets
    const tagEdgesPerNode = new Map(); // nodeId -> count

    let tagConnections = 0;
    let pairsChecked = 0;

    // For each pair of nodes sharing 2+ tags, add connection if not already linked
    // Build a set of existing edges for fast lookup
    const existingEdgePairs = new Set();
    for (const edge of kg.edges.values()) {
      existingEdgePairs.add(`${edge.from}|${edge.to}`);
      existingEdgePairs.add(`${edge.to}|${edge.from}`);
    }

    // Build node -> tag set for fast overlap calculation
    const nodeTagSets = new Map();
    for (const [id, node] of kg.nodes) {
      nodeTagSets.set(id, new Set(node.metadata?.tags || []));
    }

    // For efficiency, iterate pairs within each tag group and count shared tags
    // Use a Map to track pairs we've already evaluated
    const evaluatedPairs = new Map(); // "idA|idB" -> sharedTagCount

    for (const [tag, nodeIds] of tagGroups) {
      // Skip very large groups (generic tags like 'thought') to avoid O(n^2) explosion
      if (nodeIds.length > 200) continue;

      for (let i = 0; i < nodeIds.length; i++) {
        for (let j = i + 1; j < nodeIds.length; j++) {
          const a = nodeIds[i];
          const b = nodeIds[j];
          const pairKey = a < b ? `${a}|${b}` : `${b}|${a}`;

          // Already evaluated this pair
          if (evaluatedPairs.has(pairKey)) continue;

          // Count shared tags between a and b
          const tagsA = nodeTagSets.get(a);
          const tagsB = nodeTagSets.get(b);
          if (!tagsA || !tagsB) continue;

          let sharedCount = 0;
          for (const t of tagsA) {
            if (tagsB.has(t)) sharedCount++;
          }
          evaluatedPairs.set(pairKey, sharedCount);
        }
      }
    }

    // Now add edges for pairs with 2+ shared tags
    for (const [pairKey, sharedCount] of evaluatedPairs) {
      if (sharedCount < 2) continue;

      const [a, b] = pairKey.split('|');
      pairsChecked++;

      // Already connected?
      if (existingEdgePairs.has(`${a}|${b}`)) continue;

      // Check per-node limit (3 tag-based connections max)
      const aCount = tagEdgesPerNode.get(a) || 0;
      const bCount = tagEdgesPerNode.get(b) || 0;
      if (aCount >= 3 && bCount >= 3) continue;
      if (aCount >= 3 || bCount >= 3) {
        // Allow only if the other node still has room
        if (aCount >= 3 && bCount >= 3) continue;
      }

      const edge = kg.addEdge(a, b, 'relates-to', 0.5, { source: 'tag-overlap', sharedTags: sharedCount });
      if (edge) {
        tagConnections++;
        tagEdgesPerNode.set(a, aCount + 1);
        tagEdgesPerNode.set(b, bCount + 1);
        existingEdgePairs.add(`${a}|${b}`);
        existingEdgePairs.add(`${b}|${a}`);
      }

      // Progress
      if (tagConnections % 200 === 0 && tagConnections > 0) {
        console.log(`  ... ${tagConnections} tag-based edges added so far`);
      }
    }

    stats.phase1b_connected = tagConnections;

    // Mark TF-IDF as dirty since we added edges (nodes didn't change, but good hygiene)
    kg._tfidfDirty = true;

    console.log(`\n  Phase 1b complete: ${tagConnections} tag-based edges added`);
    console.log(`  Pairs with 2+ shared tags evaluated: ${pairsChecked}`);
    console.log(`  Time: ${elapsed(p1bStart)}`);
    console.log(`  Total edges now: ${kg.edges.size}`);
    console.log(`  Remaining orphans: ${kg.orphans().length}\n`);
  } catch (err) {
    console.error(`  [Phase 1b ERROR] ${err.message}`);
    console.error(`  ${err.stack?.split('\n').slice(0, 3).join('\n  ')}\n`);
  }

  // ══════════════════════════════════════════════════════════
  // PHASE 2: Forward Chaining (Inference)
  // ══════════════════════════════════════════════════════════
  try {
    const p2Start = Date.now();
    console.log(DIVIDER);
    console.log('  PHASE 2: Forward Chaining (20 iterations)');
    console.log(DIVIDER);

    console.log(`  Rules loaded: ${engine.reasoner.rules.length}`);
    for (const rule of engine.reasoner.rules) {
      console.log(`    - ${rule.name}`);
    }
    console.log('');

    const inferences = engine.reasoner.forwardChain(20);
    stats.phase2_inferences = inferences.length;

    console.log(`  Inferences derived: ${inferences.length}`);
    for (const inf of inferences.slice(0, 20)) {
      console.log(`    [${inf.derivedBy}] ${inf.content.slice(0, 120)}`);
      console.log(`      confidence: ${(inf.confidence || 0).toFixed(3)}`);
    }
    if (inferences.length > 20) {
      console.log(`    ... and ${inferences.length - 20} more`);
    }

    const lastLog = engine.reasoner.inferenceLog[engine.reasoner.inferenceLog.length - 1];
    if (lastLog) {
      console.log(`\n  Iterations used: ${lastLog.iterations}`);
    }

    console.log(`  Time: ${elapsed(p2Start)}\n`);
  } catch (err) {
    console.error(`  [Phase 2 ERROR] ${err.message}`);
    console.error(`  ${err.stack?.split('\n').slice(0, 3).join('\n  ')}\n`);
  }

  // ══════════════════════════════════════════════════════════
  // PHASE 3: Pattern Detection
  // ══════════════════════════════════════════════════════════
  try {
    const p3Start = Date.now();
    console.log(DIVIDER);
    console.log('  PHASE 3: Pattern Detection (30-day window)');
    console.log(DIVIDER);

    const analysis = engine.patterns.analyze({ windowDays: 30 });
    stats.phase3_patterns = analysis;

    // Frequency
    console.log('\n  Top tags:');
    for (const { key, count } of (analysis.frequency?.tags || []).slice(0, 10)) {
      console.log(`    ${key}: ${count}`);
    }

    console.log('\n  Type distribution:');
    for (const { key, count } of (analysis.frequency?.types || [])) {
      console.log(`    ${key}: ${count}`);
    }

    // Clusters
    console.log(`\n  Clusters found: ${(analysis.clusters || []).length}`);
    for (const cluster of (analysis.clusters || []).slice(0, 5)) {
      console.log(`    [${cluster.size} nodes] tags: ${cluster.tags.slice(0, 5).join(', ')} | avgConf: ${cluster.avgConfidence.toFixed(2)}`);
    }

    // Anomalies
    console.log(`\n  Anomalies detected: ${(analysis.anomalies || []).length}`);
    for (const a of (analysis.anomalies || []).slice(0, 5)) {
      console.log(`    ${a.title || a.nodeId}: ${a.reason}`);
    }

    // Cross-domain
    console.log(`\n  Cross-domain patterns: ${(analysis.crossDomain || []).length}`);
    for (const cd of (analysis.crossDomain || []).slice(0, 5)) {
      console.log(`    ${cd.domains.join(' <-> ')}: ${cd.sharedTerms.slice(0, 5).join(', ')} (overlap: ${cd.overlap.toFixed(2)})`);
    }

    console.log(`\n  Time: ${elapsed(p3Start)}\n`);
  } catch (err) {
    console.error(`  [Phase 3 ERROR] ${err.message}`);
    console.error(`  ${err.stack?.split('\n').slice(0, 3).join('\n  ')}\n`);
  }

  // ══════════════════════════════════════════════════════════
  // PHASE 4: Insight Generation
  // ══════════════════════════════════════════════════════════
  try {
    const p4Start = Date.now();
    console.log(DIVIDER);
    console.log('  PHASE 4: Insight Generation');
    console.log(DIVIDER);

    const insights = engine.reasoner.generateInsights();
    stats.phase4_insights = insights.length;

    console.log(`  Insights generated: ${insights.length}\n`);
    for (const insight of insights) {
      console.log(`  [${insight.priority}] ${insight.type}`);
      console.log(`    ${insight.content}`);
      if (insight.suggestion) console.log(`    -> ${insight.suggestion}`);
      if (insight.resolution) console.log(`    -> ${insight.resolution}`);
      console.log('');
    }

    console.log(`  Time: ${elapsed(p4Start)}\n`);
  } catch (err) {
    console.error(`  [Phase 4 ERROR] ${err.message}`);
    console.error(`  ${err.stack?.split('\n').slice(0, 3).join('\n  ')}\n`);
  }

  // ══════════════════════════════════════════════════════════
  // SAVE
  // ══════════════════════════════════════════════════════════
  try {
    console.log('[Save] Writing enriched knowledge graph...');
    engine.save();
    console.log('[Save] Done.\n');
  } catch (err) {
    console.error(`[Save ERROR] ${err.message}\n`);
  }

  // ══════════════════════════════════════════════════════════
  // FINAL REPORT
  // ══════════════════════════════════════════════════════════
  const finalReport = kg.selfReport();

  console.log(DIVIDER);
  console.log('  FIRST BOOT — FINAL REPORT');
  console.log(DIVIDER);
  console.log('');
  console.log('  BEFORE → AFTER');
  console.log(`  Nodes:     ${initialReport.totalNodes} → ${finalReport.totalNodes}`);
  console.log(`  Edges:     ${initialReport.totalEdges} → ${finalReport.totalEdges} (+${finalReport.totalEdges - initialReport.totalEdges})`);
  console.log(`  Orphans:   ${initialReport.orphanCount} → ${finalReport.orphanCount} (-${initialReport.orphanCount - finalReport.orphanCount})`);
  console.log(`  Density:   ${initialReport.density.toFixed(6)} → ${finalReport.density.toFixed(6)}`);
  console.log('');
  console.log('  CONNECTIONS MADE');
  console.log(`  Phase 1 (TF-IDF similarity): ${stats.phase1_connected} edges`);
  console.log(`  Phase 1 (no match found):    ${stats.phase1_skipped} orphans`);
  console.log(`  Phase 1b (tag overlap):      ${stats.phase1b_connected} edges`);
  console.log('');
  console.log('  REASONING');
  console.log(`  Forward-chain inferences:    ${stats.phase2_inferences}`);
  console.log(`  Insights generated:          ${stats.phase4_insights}`);
  console.log('');
  console.log('  Edge types:');
  for (const [type, count] of Object.entries(finalReport.edgesByType || {})) {
    console.log(`    ${type}: ${count}`);
  }
  console.log('');
  console.log(`  Total time: ${elapsed(t0)}`);
  console.log(`  Completed: ${new Date().toISOString()}`);
  console.log(DIVIDER);
}

// ── Run ─────────────────────────────────────────────────────

firstBoot().catch(err => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
