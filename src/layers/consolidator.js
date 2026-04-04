// ============================================================
// SOMA — Consolidator / Layer 4: What happened, and what does it mean?
//
// Episodic memory for Cortex. Converts session narratives into
// episode nodes in the knowledge graph, links them chronologically
// and by project, detects cross-session patterns, and provides
// temporal awareness (project timelines, work rhythm, dormancy).
//
// Zero tokens. Pure data processing.
// ============================================================

const fs = require('fs');
const path = require('path');

let _config = {};
try { _config = require('../../soma.config.js'); } catch (_) {}
const DATA_DIR = process.env.SOMA_DATA || _config.dataDir || path.join(__dirname, '../../data');
const NARRATIVES_FILE = path.join(DATA_DIR, 'session_narratives.json');
const ATTENTION_FILE = path.join(DATA_DIR, 'attention_log.json');
const STATE_FILE = path.join(DATA_DIR, 'consolidator_state.json');

class Consolidator {
  constructor(knowledgeGraph, options = {}) {
    this.kg = knowledgeGraph;
    this.options = options;

    // State
    this.processedNarrativeIds = [];
    this.episodes = [];           // { id, project, timestamp, tags, summary }
    this.patterns = [];           // Detected cross-session patterns
    this.lastConsolidation = null;

    // Config
    this.dormantDays = options.dormantDays || 5;
  }

  // ── Initialization ──────────────────────────────────────────

  initialize() {
    this._loadState();

    // Sync: if the graph already has episode nodes we didn't track,
    // add them to our episode list (handles restart after state loss)
    const graphEpisodes = this.kg.query({ type: 'episode' });
    for (const node of graphEpisodes) {
      const id = node.id;
      if (!this.episodes.find(e => e.id === id)) {
        this.episodes.push({
          id,
          project: node.metadata?.project || null,
          timestamp: node.metadata?.created || Date.now(),
          tags: node.metadata?.tags || [],
          summary: node.title || ''
        });
      }
      if (!this.processedNarrativeIds.includes(node.metadata?.narrativeId)) {
        const nId = node.metadata?.narrativeId;
        if (nId) this.processedNarrativeIds.push(nId);
      }
    }

    return this;
  }

  // ── Episode Formation ─────────────────────────────────────────
  // Main entry point. Called by daemon each graph cycle.

  processNewSessions() {
    const narratives = this._loadNarratives();
    if (narratives.length === 0) return { processed: 0, episodes: [] };

    const newNarratives = narratives.filter(n =>
      n.id && !this.processedNarrativeIds.includes(n.id)
    );

    if (newNarratives.length === 0) return { processed: 0, episodes: [] };

    const newEpisodes = [];

    for (const narrative of newNarratives) {
      const episode = this._createEpisode(narrative);
      if (episode) {
        newEpisodes.push(episode);
        this.processedNarrativeIds.push(narrative.id);
      }
    }

    // Build temporal links between all episodes (not just new ones)
    if (newEpisodes.length > 0) {
      this._buildTemporalLinks();
      this._buildProjectLinks();
    }

    this.lastConsolidation = Date.now();
    this._saveState();

    return { processed: newEpisodes.length, episodes: newEpisodes };
  }

  _createEpisode(narrative) {
    const timestamp = narrative.date
      ? new Date(narrative.date).getTime()
      : parseInt(narrative.id?.replace('n-', '')) || Date.now();

    const summary = this._buildSummary(narrative);
    const episodeId = `ep-${narrative.id || Date.now()}`;

    // Create episode node in the knowledge graph
    const node = this.kg.addNode({
      id: episodeId,
      type: 'episode',
      title: narrative.title || 'Untitled session',
      body: summary,
      content: summary,
      metadata: {
        confidence: 0.9,
        maturity: 'developing',
        tags: ['episode', 'consolidator', ...(narrative.tags || [])],
        source: 'consolidator',
        narrativeId: narrative.id,
        project: narrative.project || null,
        sessionId: narrative.sessionId || null,
        date: narrative.date || null,
        created: timestamp,
        updated: Date.now(),
        decisions: narrative.decisions || [],
        discoveries: narrative.discoveries || [],
        intent: narrative.intent || null
      }
    });

    if (!node) return null;

    // Connect to project nodes
    this._connectToProject(episodeId, narrative.project);

    // Connect to related thought nodes by tag/keyword matching
    this._connectToRelatedThoughts(episodeId, narrative);

    // Connect to goal nodes that may have been progressed
    this._connectToGoals(episodeId, narrative);

    // Track in local state
    const episodeEntry = {
      id: episodeId,
      project: narrative.project || null,
      timestamp,
      tags: narrative.tags || [],
      summary: (narrative.title || '').slice(0, 200)
    };
    this.episodes.push(episodeEntry);

    return episodeEntry;
  }

  _buildSummary(narrative) {
    const parts = [];
    if (narrative.body) {
      // Take first 300 chars of body as excerpt
      const excerpt = narrative.body.length > 300
        ? narrative.body.slice(0, 300) + '...'
        : narrative.body;
      parts.push(excerpt);
    }
    if (narrative.discoveries && narrative.discoveries.length > 0) {
      parts.push('Discoveries: ' + narrative.discoveries.slice(0, 3).join('; '));
    }
    if (narrative.decisions && narrative.decisions.length > 0) {
      parts.push('Decisions: ' + narrative.decisions.slice(0, 3).join('; '));
    }
    return parts.join('\n\n') || narrative.title || '';
  }

  _connectToProject(episodeId, projectName) {
    if (!projectName) return;

    const projectLower = projectName.toLowerCase();

    // Search for project nodes by title/tag match
    const candidates = [
      ...this.kg.query({ tag: projectLower }),
      ...this.kg.query({ tag: projectName }),
      ...this.kg.query({ type: 'goal', text: projectName })
    ];

    // Also check nodes whose title matches the project name
    const titleMatches = this.kg.query({ text: projectName });
    for (const node of titleMatches) {
      if (node.type === 'goal' || node.type === 'identity' ||
          (node.title && node.title.toLowerCase().includes(projectLower))) {
        candidates.push(node);
      }
    }

    // Deduplicate and connect
    const connected = new Set();
    for (const node of candidates) {
      if (!node || !node.id || node.id === episodeId || connected.has(node.id)) continue;
      // Don't connect episode to episode (temporal links handle that)
      if (node.type === 'episode') continue;
      connected.add(node.id);
      this.kg.addEdge(episodeId, node.id, 'relates-to', 0.6, {
        source: 'consolidator',
        reason: 'project-match'
      });
      if (connected.size >= 5) break; // cap connections per project
    }
  }

  _connectToRelatedThoughts(episodeId, narrative) {
    const tags = narrative.tags || [];
    const connected = new Set();

    // Match by shared tags
    for (const tag of tags) {
      const tagNodes = this.kg.byTag.get(tag);
      if (!tagNodes) continue;
      for (const nodeId of tagNodes) {
        if (nodeId === episodeId || connected.has(nodeId)) continue;
        const node = this.kg.getNode(nodeId);
        if (!node || node.type === 'episode') continue;

        // Require at least 2 shared tags for a connection
        const nodeTags = new Set(node.metadata?.tags || []);
        const overlap = tags.filter(t => nodeTags.has(t)).length;
        if (overlap >= 2) {
          connected.add(nodeId);
          this.kg.addEdge(episodeId, nodeId, 'relates-to', Math.min(1, 0.3 + overlap * 0.15), {
            source: 'consolidator',
            reason: 'tag-overlap',
            sharedTags: tags.filter(t => nodeTags.has(t))
          });
        }
        if (connected.size >= 10) break;
      }
      if (connected.size >= 10) break;
    }

    // Also connect via TF-IDF text similarity if we have content
    if (this.kg.nodes.has(episodeId)) {
      const similar = this.kg.findSimilar(episodeId, 0.2, 5);
      for (const s of similar) {
        if (s.id === episodeId || connected.has(s.id)) continue;
        const node = this.kg.getNode(s.id);
        if (!node || node.type === 'episode') continue;
        connected.add(s.id);
        this.kg.addEdge(episodeId, s.id, 'relates-to', Math.min(1, s.similarity), {
          source: 'consolidator',
          reason: 'text-similarity'
        });
      }
    }
  }

  _connectToGoals(episodeId, narrative) {
    const goals = this.kg.query({ type: 'goal' });
    if (goals.length === 0) return;

    // Check if any narrative content references goal keywords
    const narrativeText = [
      narrative.title || '',
      narrative.body || '',
      ...(narrative.decisions || []),
      ...(narrative.discoveries || []),
      narrative.intent || ''
    ].join(' ').toLowerCase();

    for (const goal of goals) {
      const goalTitle = (goal.title || '').toLowerCase();
      const goalTags = (goal.metadata?.tags || []).map(t => t.toLowerCase());

      // Title word overlap (excluding common words)
      const goalWords = goalTitle.split(/\s+/).filter(w => w.length > 4);
      const matchCount = goalWords.filter(w => narrativeText.includes(w)).length;

      // Tag overlap
      const narrativeTags = (narrative.tags || []).map(t => t.toLowerCase());
      const tagOverlap = goalTags.filter(t => narrativeTags.includes(t)).length;

      if (matchCount >= 2 || tagOverlap >= 2) {
        this.kg.addEdge(episodeId, goal.id, 'supports', 0.7, {
          source: 'consolidator',
          reason: 'goal-alignment'
        });
      }
    }
  }

  // ── Temporal Links ──────────────────────────────────────────

  _buildTemporalLinks() {
    // Sort all episodes chronologically
    const sorted = [...this.episodes].sort((a, b) => a.timestamp - b.timestamp);

    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i];
      const next = sorted[i + 1];

      // Only add if both nodes exist in graph
      if (!this.kg.getNode(current.id) || !this.kg.getNode(next.id)) continue;

      // Check if temporal-next edge already exists
      const existing = this.kg.getEdgesBetween(current.id, next.id)
        .filter(e => e.type === 'temporal-next');
      if (existing.length > 0) continue;

      this.kg.addEdge(current.id, next.id, 'temporal-next', 1.0, {
        source: 'consolidator',
        gap: next.timestamp - current.timestamp
      });
    }
  }

  _buildProjectLinks() {
    // Group episodes by project
    const byProject = new Map();
    for (const ep of this.episodes) {
      if (!ep.project) continue;
      const key = ep.project.toLowerCase();
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(ep);
    }

    // Within each project, link consecutive episodes
    for (const [, projectEpisodes] of byProject) {
      if (projectEpisodes.length < 2) continue;
      const sorted = [...projectEpisodes].sort((a, b) => a.timestamp - b.timestamp);

      for (let i = 0; i < sorted.length - 1; i++) {
        const current = sorted[i];
        const next = sorted[i + 1];

        if (!this.kg.getNode(current.id) || !this.kg.getNode(next.id)) continue;

        const existing = this.kg.getEdgesBetween(current.id, next.id)
          .filter(e => e.type === 'same-project');
        if (existing.length > 0) continue;

        this.kg.addEdge(current.id, next.id, 'same-project', 0.8, {
          source: 'consolidator',
          project: current.project
        });
      }
    }
  }

  // ── Cross-Session Pattern Detection ───────────────────────────

  detectPatterns() {
    const newPatterns = [];

    // 1. Recurring topics
    const recurring = this._findRecurringTopics();
    newPatterns.push(...recurring);

    // 2. Revisited problems
    const revisited = this._findRevisitedProblems();
    newPatterns.push(...revisited);

    // 3. Work rhythm
    const rhythm = this._analyzeWorkRhythm();
    if (rhythm) newPatterns.push(rhythm);

    // 4. Project momentum
    const momentum = this._analyzeProjectMomentum();
    newPatterns.push(...momentum);

    // 5. Dormant project signals
    const dormant = this._findDormantProjects();
    newPatterns.push(...dormant);

    // Deduplicate against existing patterns by type+subject
    const existingKeys = new Set(
      this.patterns.map(p => `${p.type}:${p.subject || ''}`)
    );

    const genuinelyNew = newPatterns.filter(p => {
      const key = `${p.type}:${p.subject || ''}`;
      return !existingKeys.has(key);
    });

    // Replace patterns that match type+subject (updated data), add new ones
    for (const pattern of newPatterns) {
      const key = `${pattern.type}:${pattern.subject || ''}`;
      const idx = this.patterns.findIndex(p =>
        `${p.type}:${p.subject || ''}` === key
      );
      if (idx >= 0) {
        this.patterns[idx] = pattern; // Update existing
      } else {
        this.patterns.push(pattern);
      }
    }

    // Cap stored patterns
    if (this.patterns.length > 100) {
      this.patterns = this.patterns.slice(-100);
    }

    this._saveState();

    return {
      total: newPatterns.length,
      new: genuinelyNew.length,
      patterns: newPatterns
    };
  }

  _findRecurringTopics() {
    const results = [];

    // Count tag frequency across episodes
    const tagEpisodes = new Map(); // tag -> Set<episodeId>
    for (const ep of this.episodes) {
      for (const tag of (ep.tags || [])) {
        if (tag === 'episode' || tag === 'consolidator') continue;
        if (!tagEpisodes.has(tag)) tagEpisodes.set(tag, new Set());
        tagEpisodes.get(tag).add(ep.id);
      }
    }

    // Tags appearing in 3+ episodes
    for (const [tag, episodeIds] of tagEpisodes) {
      if (episodeIds.size >= 3) {
        const episodes = [...episodeIds]
          .map(id => this.episodes.find(e => e.id === id))
          .filter(Boolean)
          .sort((a, b) => a.timestamp - b.timestamp);

        const span = episodes.length >= 2
          ? episodes[episodes.length - 1].timestamp - episodes[0].timestamp
          : 0;
        const spanDays = Math.round(span / 86400000);

        results.push({
          type: 'recurring-theme',
          subject: tag,
          count: episodeIds.size,
          spanDays,
          firstSeen: episodes[0]?.timestamp,
          lastSeen: episodes[episodes.length - 1]?.timestamp,
          episodeIds: [...episodeIds],
          description: `"${tag}" appears in ${episodeIds.size} sessions over ${spanDays} days`,
          detectedAt: Date.now()
        });
      }
    }

    return results.sort((a, b) => b.count - a.count);
  }

  _findRevisitedProblems() {
    const results = [];

    // Look for episodes in the same project where decisions overlap or conflict
    const byProject = new Map();
    for (const ep of this.episodes) {
      if (!ep.project) continue;
      const key = ep.project.toLowerCase();
      if (!byProject.has(key)) byProject.set(key, []);

      // Enrich episode with decisions from the graph node
      const node = this.kg.getNode(ep.id);
      const decisions = node?.metadata?.decisions || [];
      byProject.get(key).push({ ...ep, decisions });
    }

    for (const [project, episodes] of byProject) {
      if (episodes.length < 2) continue;
      const sorted = [...episodes].sort((a, b) => a.timestamp - b.timestamp);

      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const earlier = sorted[i];
          const later = sorted[j];

          if (!earlier.decisions.length || !later.decisions.length) continue;

          // Tokenize decisions and look for significant overlap
          const earlierWords = new Set(
            earlier.decisions.join(' ').toLowerCase()
              .split(/\s+/)
              .filter(w => w.length > 4)
          );
          const laterWords = later.decisions.join(' ').toLowerCase()
            .split(/\s+/)
            .filter(w => w.length > 4);

          const overlap = laterWords.filter(w => earlierWords.has(w));
          const uniqueOverlap = [...new Set(overlap)];

          if (uniqueOverlap.length >= 3) {
            results.push({
              type: 'revisited-problem',
              subject: project,
              earlierEpisode: earlier.id,
              laterEpisode: later.id,
              overlapWords: uniqueOverlap.slice(0, 10),
              gapDays: Math.round((later.timestamp - earlier.timestamp) / 86400000),
              description: `Project "${project}": decisions in session ${later.summary.slice(0, 50)} revisit topics from ${earlier.summary.slice(0, 50)}`,
              detectedAt: Date.now()
            });
          }
        }
      }
    }

    return results;
  }

  _analyzeWorkRhythm() {
    if (this.episodes.length < 3) return null;

    const sorted = [...this.episodes].sort((a, b) => a.timestamp - b.timestamp);

    // Session gaps
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(sorted[i].timestamp - sorted[i - 1].timestamp);
    }

    const avgGapMs = gaps.length > 0
      ? gaps.reduce((a, b) => a + b, 0) / gaps.length
      : 0;
    const avgGapDays = avgGapMs / 86400000;

    // Sessions per week (based on total span)
    const totalSpan = sorted[sorted.length - 1].timestamp - sorted[0].timestamp;
    const totalWeeks = Math.max(1, totalSpan / (7 * 86400000));
    const sessionsPerWeek = sorted.length / totalWeeks;

    // Longest gap
    const maxGap = gaps.length > 0 ? Math.max(...gaps) : 0;
    const maxGapDays = maxGap / 86400000;

    // Day-of-week distribution (if dates are parseable)
    const dayOfWeekCounts = new Array(7).fill(0);
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    for (const ep of sorted) {
      const d = new Date(ep.timestamp);
      if (!isNaN(d.getTime())) {
        dayOfWeekCounts[d.getDay()]++;
      }
    }
    const peakDay = dayOfWeekCounts.indexOf(Math.max(...dayOfWeekCounts));

    return {
      type: 'work-rhythm',
      subject: 'overall',
      totalSessions: sorted.length,
      sessionsPerWeek: Math.round(sessionsPerWeek * 10) / 10,
      avgGapDays: Math.round(avgGapDays * 10) / 10,
      maxGapDays: Math.round(maxGapDays * 10) / 10,
      peakDay: dayNames[peakDay],
      dayDistribution: Object.fromEntries(dayNames.map((name, i) => [name, dayOfWeekCounts[i]])),
      description: `${sorted.length} sessions, ~${(Math.round(sessionsPerWeek * 10) / 10)}/week, avg ${(Math.round(avgGapDays * 10) / 10)}d gap, peak: ${dayNames[peakDay]}`,
      detectedAt: Date.now()
    };
  }

  _analyzeProjectMomentum() {
    const results = [];

    // Group episodes by project with timestamps
    const byProject = new Map();
    for (const ep of this.episodes) {
      if (!ep.project) continue;
      const key = ep.project.toLowerCase();
      if (!byProject.has(key)) byProject.set(key, { name: ep.project, sessions: [] });
      byProject.get(key).sessions.push(ep.timestamp);
    }

    const now = Date.now();

    for (const [, data] of byProject) {
      if (data.sessions.length < 2) continue;

      const sorted = data.sessions.sort((a, b) => a - b);
      const recent = sorted.filter(t => now - t < 14 * 86400000); // last 14 days
      const older = sorted.filter(t => now - t >= 14 * 86400000 && now - t < 28 * 86400000); // 14-28 days ago

      // Acceleration: more sessions recently than previously
      let trend = 'stable';
      if (recent.length > older.length + 1) trend = 'accelerating';
      else if (recent.length < older.length - 1) trend = 'decelerating';

      // Days since last session
      const daysSinceLast = (now - sorted[sorted.length - 1]) / 86400000;

      results.push({
        type: 'project-momentum',
        subject: data.name,
        totalSessions: sorted.length,
        recentSessions: recent.length,
        olderSessions: older.length,
        trend,
        daysSinceLast: Math.round(daysSinceLast * 10) / 10,
        description: `"${data.name}": ${trend} (${recent.length} sessions in 14d vs ${older.length} prior), last touch ${Math.round(daysSinceLast)}d ago`,
        detectedAt: Date.now()
      });
    }

    return results.sort((a, b) => {
      const order = { accelerating: 0, stable: 1, decelerating: 2 };
      return (order[a.trend] || 1) - (order[b.trend] || 1);
    });
  }

  _findDormantProjects() {
    const results = [];
    const now = Date.now();
    const dormantThreshold = this.dormantDays * 86400000;

    // Collect last-touch per project
    const lastTouch = new Map();
    for (const ep of this.episodes) {
      if (!ep.project) continue;
      const key = ep.project.toLowerCase();
      const current = lastTouch.get(key);
      if (!current || ep.timestamp > current.timestamp) {
        lastTouch.set(key, { name: ep.project, timestamp: ep.timestamp });
      }
    }

    for (const [, data] of lastTouch) {
      const gap = now - data.timestamp;
      if (gap >= dormantThreshold) {
        const gapDays = Math.round(gap / 86400000);
        results.push({
          type: 'dormant-project',
          subject: data.name,
          daysSinceLast: gapDays,
          lastTouch: data.timestamp,
          description: `"${data.name}" hasn't been touched in ${gapDays} days`,
          detectedAt: Date.now()
        });
      }
    }

    return results.sort((a, b) => b.daysSinceLast - a.daysSinceLast);
  }

  // ── Temporal Awareness API ────────────────────────────────────

  getProjectTimeline(projectName) {
    const key = projectName.toLowerCase();
    return this.episodes
      .filter(ep => ep.project && ep.project.toLowerCase() === key)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(ep => {
        const node = this.kg.getNode(ep.id);
        return {
          id: ep.id,
          date: node?.metadata?.date || new Date(ep.timestamp).toISOString().split('T')[0],
          title: node?.title || ep.summary,
          tags: ep.tags,
          decisions: node?.metadata?.decisions || [],
          discoveries: node?.metadata?.discoveries || []
        };
      });
  }

  getTimeSinceLastTouch(projectName) {
    const key = projectName.toLowerCase();
    const projectEpisodes = this.episodes
      .filter(ep => ep.project && ep.project.toLowerCase() === key);

    if (projectEpisodes.length === 0) return null;

    const latest = Math.max(...projectEpisodes.map(e => e.timestamp));
    const days = (Date.now() - latest) / 86400000;
    return Math.round(days * 10) / 10;
  }

  getWorkRhythm() {
    const rhythm = this._analyzeWorkRhythm();
    if (!rhythm) return { totalSessions: 0, message: 'Not enough sessions for rhythm analysis' };

    // Enrich with attention data if available
    const attention = this._loadAttention();
    if (attention.sessions && attention.sessions.length > 0) {
      const durations = attention.sessions
        .filter(s => s.summary?.duration)
        .map(s => s.summary.duration);

      if (durations.length > 0) {
        rhythm.avgSessionDurationSec = Math.round(
          durations.reduce((a, b) => a + b, 0) / durations.length
        );
      }
    }

    return rhythm;
  }

  getDormantProjects() {
    return this._findDormantProjects();
  }

  // ── Status / Self-Report ──────────────────────────────────────

  getStatus() {
    return {
      episodeCount: this.episodes.length,
      processedNarratives: this.processedNarrativeIds.length,
      patternCount: this.patterns.length,
      lastConsolidation: this.lastConsolidation,
      projects: this._projectSummary(),
      dormant: this._findDormantProjects().map(d => ({
        project: d.subject,
        daysSinceLast: d.daysSinceLast
      })),
      patterns: this.patterns.slice(-10).map(p => ({
        type: p.type,
        subject: p.subject,
        description: p.description
      }))
    };
  }

  selfReport() {
    return {
      capabilities: [
        'episode-formation',
        'temporal-linking',
        'recurring-theme-detection',
        'revisited-problem-detection',
        'work-rhythm-analysis',
        'project-momentum-tracking',
        'dormant-project-detection'
      ],
      description: 'Episodic memory for Cortex. Converts session narratives into ' +
        'linked episode nodes, detects cross-session patterns, and tracks ' +
        'temporal awareness across projects.',
      episodes: this.episodes.length,
      patterns: this.patterns.length,
      lastConsolidation: this.lastConsolidation
    };
  }

  _projectSummary() {
    const byProject = new Map();
    for (const ep of this.episodes) {
      if (!ep.project) continue;
      const key = ep.project.toLowerCase();
      if (!byProject.has(key)) byProject.set(key, { name: ep.project, count: 0, lastTouch: 0 });
      const data = byProject.get(key);
      data.count++;
      if (ep.timestamp > data.lastTouch) data.lastTouch = ep.timestamp;
    }
    return [...byProject.values()].sort((a, b) => b.lastTouch - a.lastTouch);
  }

  // ── Persistence ───────────────────────────────────────────────

  _loadState() {
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      this.processedNarrativeIds = data.processedNarrativeIds || [];
      this.episodes = data.episodes || [];
      this.patterns = data.patterns || [];
      this.lastConsolidation = data.lastConsolidation || null;
    } catch {
      // Corrupted state — start fresh, will re-process narratives
      this.processedNarrativeIds = [];
      this.episodes = [];
      this.patterns = [];
      this.lastConsolidation = null;
    }
  }

  _saveState() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        processedNarrativeIds: this.processedNarrativeIds,
        episodes: this.episodes,
        patterns: this.patterns,
        lastConsolidation: this.lastConsolidation,
        savedAt: Date.now()
      }, null, 2));
    } catch {
      // Non-fatal — state will be rebuilt next run
    }
  }

  _loadNarratives() {
    try {
      if (!fs.existsSync(NARRATIVES_FILE)) return [];
      const raw = JSON.parse(fs.readFileSync(NARRATIVES_FILE, 'utf8'));
      return raw.narratives || [];
    } catch {
      return [];
    }
  }

  _loadAttention() {
    try {
      if (!fs.existsSync(ATTENTION_FILE)) return {};
      return JSON.parse(fs.readFileSync(ATTENTION_FILE, 'utf8'));
    } catch {
      return {};
    }
  }
}

module.exports = { Consolidator };
