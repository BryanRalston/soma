'use strict';

/**
 * transcript-analyzer.js
 * Learns aggregate patterns from the user's full session JSONL corpus.
 * Reads the rich session files in ~/.claude/projects/<project>/
 * NEVER stores individual message content — only aggregate stats.
 *
 * Exports:
 *   analyzeTranscripts(projectPath, options) — per-project deep analysis
 *   analyzeHistory(historyPath)              — compact history.jsonl analysis
 *   generateInsights(stats)                 — convert stats → thoughtstream entries
 */

const fs   = require('fs');
const path = require('path');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_PROJECTS_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || 'C:/Users/bryan',
  '.claude', 'projects'
);
const HISTORY_FILE = path.join(
  process.env.USERPROFILE || process.env.HOME || 'C:/Users/bryan',
  '.claude', 'history.jsonl'
);

const MAX_FILES_PER_RUN     = 100;
const MAX_LINES_PER_FILE    = 500;
const STOPWORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','is','it','its','this','that','these','those','be','been','being',
  'have','has','had','do','does','did','will','would','could','should','may',
  'might','shall','can','i','my','me','we','our','you','your','he','she','they',
  'them','their','what','which','who','how','when','where','why','all','any',
  'some','no','not','also','just','are','was','were','as','up','if','so','then',
  'than','there','here','get','got','go','let','make','made','use','used','can',
  'now','new','need','want','help','know','think','see','look','check','add',
  'fix','run','try','yes','ok','please','thanks','sure','yeah','like','good',
  'right','way','time','work','working','still','more','into','out','only',
  'about','after','before','well','back','first','last','next','same','too',
  'very','really','already','dont','cant','doesnt','im','ive','its','wont',
  'thats','its','heres','whats',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive a short project name from a path or encoded directory name. */
function deriveProjectName(rawPath) {
  if (!rawPath) return 'unknown';
  // Encoded dir names: C--Cortex, C--UnityProjects-Brix3D
  const normalized = rawPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'unknown';
}

/** Slugify a Windows absolute path to the encoded project dir name. */
function pathToProjectDir(absPath) {
  // e.g. C:\MyProject -> C--MyProject
  return absPath
    .replace(/:/g, '-')
    .replace(/[\\/]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Extract simple word tokens from a string, lower-cased, filter stopwords. */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

/** Increment a frequency map key. */
function inc(map, key, amount = 1) {
  map[key] = (map[key] || 0) + amount;
}

/** Sort frequency map entries descending, return top N pairs. */
function topN(map, n = 20) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

/** Format an hour (0-23) as "2am" / "3pm" etc. */
function fmtHour(h) {
  if (h === 0)  return '12am';
  if (h < 12)   return `${h}am`;
  if (h === 12) return '12pm';
  return `${h - 12}pm`;
}

// ---------------------------------------------------------------------------
// analyzeTranscripts(projectPath, options)
// ---------------------------------------------------------------------------
// options:
//   maxFiles         {number}  default MAX_FILES_PER_RUN
//   maxLinesPerFile  {number}  default MAX_LINES_PER_FILE
//   projectFilter    {string}  optional: only process dirs matching this substring

async function analyzeTranscripts(projectPath, options = {}) {
  const {
    maxFiles        = MAX_FILES_PER_RUN,
    maxLinesPerFile = MAX_LINES_PER_FILE,
    projectFilter   = null,
  } = options;

  const baseDir = projectPath || CLAUDE_PROJECTS_DIR;

  // Collect all project directories
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(baseDir).filter(name => {
      const full = path.join(baseDir, name);
      return fs.statSync(full).isDirectory();
    });
  } catch (err) {
    return { error: `Cannot read projects dir: ${err.message}` };
  }

  if (projectFilter) {
    projectDirs = projectDirs.filter(d =>
      d.toLowerCase().includes(projectFilter.toLowerCase())
    );
  }

  // --- Aggregate buckets ---
  const wordFreq      = {};   // word → count
  const projectMsgs   = {};   // projectLabel → { messages, sessions, totalChars }
  const byHour        = {};   // 0-23 → count
  const byDayOfWeek   = {};   // 0-6 → count
  const sessionStats  = {};   // sessionId → { first, last, count, projectLabel }
  // Momentum: last topic of each session → start topic of next (same project)
  const sessionLastWord  = {}; // sessionId → last meaningful word
  const momentumPairs    = {}; // "end→start" → count

  for (let h = 0; h < 24; h++) byHour[h] = 0;
  for (let d = 0; d < 7;  d++) byDayOfWeek[d] = 0;

  let totalUserMessages = 0;
  let filesAnalyzed     = 0;
  let linesRead         = 0;

  // Process each project dir
  for (const dirName of projectDirs) {
    if (filesAnalyzed >= maxFiles) break;

    const dirPath = path.join(baseDir, dirName);
    let jsonlFiles;
    try {
      jsonlFiles = fs.readdirSync(dirPath)
        .filter(f => f.endsWith('.jsonl'))
        .sort();                          // chronological by name (UUID not sortable, but consistent)
    } catch {
      continue;
    }

    const projectLabel = deriveProjectName(dirName.replace(/--/g, '/'));

    for (const fname of jsonlFiles) {
      if (filesAnalyzed >= maxFiles) break;
      filesAnalyzed++;

      const filePath = path.join(dirPath, fname);
      let lineCount  = 0;

      try {
        const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        for await (const rawLine of rl) {
          if (lineCount >= maxLinesPerFile) { rl.close(); stream.destroy(); break; }
          lineCount++;
          linesRead++;

          const line = rawLine.trim();
          if (!line) continue;

          let obj;
          try { obj = JSON.parse(line); } catch { continue; }

          // Only care about user-role messages
          if (obj.type !== 'user') continue;

          // Skip sidechain messages (Soma/daemon internal traffic)
          if (obj.isSidechain) continue;

          // Require a message object with string content
          const msg = obj.message;
          if (!msg || msg.role !== 'user') continue;

          const content = typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content.map(c => (typeof c === 'string' ? c : c.text || '')).join(' ')
              : null;
          if (!content || !content.trim()) continue;

          // --- Extract fields ---
          const ts        = obj.timestamp ? new Date(obj.timestamp) : null;
          const sessionId = obj.sessionId || null;
          const msgLen    = content.length;

          totalUserMessages++;

          // Project aggregation
          if (!projectMsgs[projectLabel]) {
            projectMsgs[projectLabel] = { messages: 0, sessions: new Set(), totalChars: 0 };
          }
          projectMsgs[projectLabel].messages++;
          projectMsgs[projectLabel].totalChars += msgLen;
          if (sessionId) projectMsgs[projectLabel].sessions.add(sessionId);

          // Time distribution
          if (ts) {
            byHour[ts.getHours()]++;
            byDayOfWeek[ts.getDay()]++;
          }

          // Session length tracking
          if (sessionId && ts) {
            const tsMs = ts.getTime();
            if (!sessionStats[sessionId]) {
              sessionStats[sessionId] = {
                first: tsMs, last: tsMs, count: 0,
                projectLabel, lastWord: null,
              };
            }
            if (tsMs < sessionStats[sessionId].first) sessionStats[sessionId].first = tsMs;
            if (tsMs > sessionStats[sessionId].last)  sessionStats[sessionId].last  = tsMs;
            sessionStats[sessionId].count++;
            sessionStats[sessionId].projectLabel = projectLabel;
          }

          // Word frequency — first 100 chars only (not full content)
          const preview = content.slice(0, 100);
          const tokens  = tokenize(preview);
          tokens.forEach(w => inc(wordFreq, w));

          // Track last meaningful word for momentum analysis
          if (sessionId && tokens.length > 0) {
            sessionStats[sessionId] = sessionStats[sessionId] || {
              first: null, last: null, count: 0, projectLabel, lastWord: null,
            };
            sessionStats[sessionId].lastWord = tokens[tokens.length - 1];
          }
        }
      } catch (err) {
        // Skip unreadable files silently
        continue;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Derive session length distribution
  // ---------------------------------------------------------------------------
  const MAX_SESSION_MIN = 240;
  const durations = Object.values(sessionStats)
    .filter(s => s.last > s.first)
    .map(s => (s.last - s.first) / 60000);
  const cappedDurations = durations.filter(d => d <= MAX_SESSION_MIN);

  const avgSessionLength = cappedDurations.length > 0
    ? Math.round(cappedDurations.reduce((a, b) => a + b, 0) / cappedDurations.length)
    : 0;

  const sessionLengthBuckets = { short: 0, medium: 0, long: 0 };
  cappedDurations.forEach(d => {
    if (d < 15)       sessionLengthBuckets.short++;
    else if (d < 60)  sessionLengthBuckets.medium++;
    else              sessionLengthBuckets.long++;
  });

  // ---------------------------------------------------------------------------
  // Momentum pairs — build from session data
  // Sort sessions per project chronologically, pair consecutive last→first words
  // ---------------------------------------------------------------------------
  const sessionsByProject = {};
  for (const [sid, s] of Object.entries(sessionStats)) {
    const p = s.projectLabel;
    if (!sessionsByProject[p]) sessionsByProject[p] = [];
    sessionsByProject[p].push({ ...s, sessionId: sid });
  }

  for (const sessions of Object.values(sessionsByProject)) {
    sessions.sort((a, b) => (a.first || 0) - (b.first || 0));
    for (let i = 0; i < sessions.length - 1; i++) {
      const endWord   = sessions[i].lastWord;
      const startData = sessions[i + 1];
      // We only have the end word; start word not captured per-session,
      // so pair it with the project for momentum insight
      if (endWord) {
        const key = endWord;
        inc(momentumPairs, key);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Finalize project stats (serialize Sets)
  // ---------------------------------------------------------------------------
  const projectList = Object.entries(projectMsgs)
    .map(([name, d]) => ({
      name,
      messages:   d.messages,
      sessions:   d.sessions.size,
      avgMsgLen:  d.messages > 0 ? Math.round(d.totalChars / d.messages) : 0,
      pct:        totalUserMessages > 0
                  ? Math.round((d.messages / totalUserMessages) * 1000) / 10
                  : 0,
    }))
    .sort((a, b) => b.messages - a.messages);

  // Peak hour & day
  const peakHour = parseInt(
    Object.entries(byHour).sort((a, b) => b[1] - a[1])[0][0], 10
  );
  const peakDow = parseInt(
    Object.entries(byDayOfWeek).sort((a, b) => b[1] - a[1])[0][0], 10
  );
  const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  return {
    generatedAt: new Date().toISOString(),
    source: 'session-transcripts',
    filesAnalyzed,
    linesRead,
    totalUserMessages,
    sessionCount: Object.keys(sessionStats).length,
    avgSessionLength,
    sessionLengthBuckets,
    peakHour,
    peakHourLabel: fmtHour(peakHour),
    peakDow,
    peakDowName: DOW[peakDow],
    topProjects: projectList.slice(0, 10),
    allProjects: projectList,
    topWords: topN(wordFreq, 30),
    topMomentumWords: topN(momentumPairs, 15),
    byHour,
    byDayOfWeek,
  };
}

// ---------------------------------------------------------------------------
// analyzeHistory(historyPath)
// Reads history.jsonl (compact prompt log) for high-level patterns.
// ---------------------------------------------------------------------------

async function analyzeHistory(historyPath) {
  const filePath = historyPath || HISTORY_FILE;

  const byProject   = {};
  const byHour      = {};
  const byDayOfWeek = {};
  const startingWords = {};  // first word of each prompt
  const bySession   = {};

  for (let h = 0; h < 24; h++) byHour[h] = 0;
  for (let d = 0; d < 7;  d++) byDayOfWeek[d] = 0;

  let total = 0;

  try {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;

      let obj;
      try { obj = JSON.parse(line); } catch { continue; }

      const { timestamp, project: projectPath, sessionId, display } = obj;
      if (!timestamp) continue;

      total++;
      const dt  = new Date(timestamp);
      const ts  = timestamp;

      byHour[dt.getHours()]++;
      byDayOfWeek[dt.getDay()]++;

      const projectLabel = deriveProjectName(projectPath || '');
      if (!byProject[projectLabel]) {
        byProject[projectLabel] = { messages: 0, sessions: new Set(), firstSeen: ts, lastSeen: ts };
      }
      const p = byProject[projectLabel];
      p.messages++;
      if (sessionId) p.sessions.add(sessionId);
      if (ts < p.firstSeen) p.firstSeen = ts;
      if (ts > p.lastSeen)  p.lastSeen  = ts;

      // Session span
      if (sessionId) {
        if (!bySession[sessionId]) bySession[sessionId] = { first: ts, last: ts, count: 0 };
        if (ts < bySession[sessionId].first) bySession[sessionId].first = ts;
        if (ts > bySession[sessionId].last)  bySession[sessionId].last  = ts;
        bySession[sessionId].count++;
      }

      // Starting words (from display field, first 60 chars)
      if (display && typeof display === 'string' && !display.startsWith('[Pasted')) {
        const firstWord = tokenize(display.slice(0, 60))[0];
        if (firstWord) inc(startingWords, firstWord);
      }
    }
  } catch (err) {
    return { error: `Cannot read history file: ${err.message}` };
  }

  const projectList = Object.entries(byProject)
    .map(([name, d]) => ({
      name,
      messages: d.messages,
      sessions: d.sessions.size,
      pct: total > 0 ? Math.round((d.messages / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.messages - a.messages);

  const peakHour = parseInt(
    Object.entries(byHour).sort((a, b) => b[1] - a[1])[0][0], 10
  );
  const peakDow = parseInt(
    Object.entries(byDayOfWeek).sort((a, b) => b[1] - a[1])[0][0], 10
  );
  const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  const MAX_SESSION_MIN = 240;
  const durations = Object.values(bySession)
    .filter(s => s.last > s.first)
    .map(s => (s.last - s.first) / 60000)
    .filter(d => d <= MAX_SESSION_MIN);

  const avgSessionLength = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : 0;

  return {
    generatedAt: new Date().toISOString(),
    source: 'history.jsonl',
    totalPrompts: total,
    sessionCount: Object.keys(bySession).length,
    avgSessionLength,
    peakHour,
    peakHourLabel: fmtHour(peakHour),
    peakDow,
    peakDowName: DOW[peakDow],
    topProjects: projectList.slice(0, 10),
    topStartingWords: topN(startingWords, 15),
    byHour,
    byDayOfWeek,
  };
}

// ---------------------------------------------------------------------------
// generateInsights(stats)
// Converts aggregate stats from either analyze function into an array of
// thoughtstream-ready objects. Does NOT post — caller does that.
// ---------------------------------------------------------------------------

function generateInsights(stats) {
  const insights = [];

  if (!stats || stats.error) return insights;

  const source = stats.source || 'transcript-analysis';
  const isHistory = source === 'history.jsonl';

  // ── Insight 1: Project attention distribution ─────────────────────────────
  if (stats.topProjects && stats.topProjects.length > 0) {
    const top = stats.topProjects.slice(0, 5);
    const lines = top.map(p =>
      `- ${p.name}: ${p.messages} messages (${p.pct}%, ${p.sessions} sessions)`
    );
    insights.push({
      title: 'Project attention distribution from conversation history',
      body: [
        `Analyzed ${(stats.totalUserMessages || stats.totalPrompts || 0).toLocaleString()} messages across ${stats.sessionCount} sessions.`,
        '',
        'Where attention goes by message volume:',
        ...lines,
        '',
        `Data source: ${source}.`,
      ].join('\n'),
      type:  'observation',
      tags:  ['attention', 'patterns', 'soma', 'projects', 'history'],
    });
  }

  // ── Insight 2: Working hours ──────────────────────────────────────────────
  if (stats.peakHour !== undefined && stats.byHour) {
    const blocks = [
      { label: 'Midnight–6am', range: [0, 6] },
      { label: '6am–Noon',     range: [6, 12] },
      { label: 'Noon–6pm',     range: [12, 18] },
      { label: '6pm–Midnight', range: [18, 24] },
    ];
    const blockCounts = blocks.map(b => ({
      label: b.label,
      count: Object.entries(stats.byHour)
        .filter(([h]) => +h >= b.range[0] && +h < b.range[1])
        .reduce((s, [, c]) => s + c, 0),
    }));
    const maxCount   = Math.max(...blockCounts.map(b => b.count));
    const peakBlock  = blockCounts.find(b => b.count === maxCount);

    insights.push({
      title: `Peak working hours are ${stats.peakHourLabel} (${stats.peakDowName}s)`,
      body: [
        `Peak activity is at ${stats.peakHourLabel} local time, most active on ${stats.peakDowName}s.`,
        '',
        'Activity by time block:',
        ...blockCounts.map(b => `- ${b.label}: ${b.count} messages`),
        '',
        peakBlock
          ? `Most active block: ${peakBlock.label} with ${peakBlock.count} messages.`
          : '',
        '',
        `Source: ${source}.`,
      ].join('\n'),
      type:  'observation',
      tags:  ['attention', 'working-hours', 'patterns', 'soma'],
    });
  }

  // ── Insight 3: Session length patterns ───────────────────────────────────
  if (stats.avgSessionLength !== undefined) {
    const buckets = stats.sessionLengthBuckets;
    const lines   = [];
    if (buckets) {
      const total = buckets.short + buckets.medium + buckets.long;
      lines.push(`- Short (<15 min): ${buckets.short} sessions (${pct(buckets.short, total)}%)`);
      lines.push(`- Medium (15–60 min): ${buckets.medium} sessions (${pct(buckets.medium, total)}%)`);
      lines.push(`- Long (>60 min): ${buckets.long} sessions (${pct(buckets.long, total)}%)`);
    }

    insights.push({
      title: `Average session is ${stats.avgSessionLength} minutes — ${sessionCharacter(stats.avgSessionLength)}`,
      body: [
        `Mean session duration: ${stats.avgSessionLength} minutes (capped at 240 min to exclude multi-day gaps).`,
        '',
        ...(lines.length ? ['Session length distribution:', ...lines, ''] : []),
        sessionCharacter(stats.avgSessionLength) === 'deep work'
          ? 'Long average session time suggests extended focus states, not quick check-ins.'
          : 'Short average session time suggests quick, targeted interactions rather than extended focus.',
        '',
        `Source: ${source}.`,
      ].join('\n'),
      type:  'observation',
      tags:  ['attention', 'session-length', 'focus', 'soma'],
    });
  }

  // ── Insight 4: Topic frequency (transcript only) ──────────────────────────
  if (!isHistory && stats.topWords && stats.topWords.length > 0) {
    const top10 = stats.topWords.slice(0, 10);
    insights.push({
      title: 'Most frequent topics in session prompts',
      body: [
        'Word frequency analysis of the first 100 characters of each user message:',
        '',
        top10.map(([w, c]) => `- "${w}": ${c}`).join('\n'),
        '',
        'These are the words reached for first — the entry points into conversations.',
        '',
        `Source: ${source} (${stats.filesAnalyzed} files, ${stats.linesRead} lines).`,
      ].join('\n'),
      type:  'observation',
      tags:  ['attention', 'topics', 'patterns', 'soma', 'language'],
    });
  }

  // ── Insight 5: Momentum patterns (transcript only) ────────────────────────
  if (!isHistory && stats.topMomentumWords && stats.topMomentumWords.length > 0) {
    const top5 = stats.topMomentumWords.slice(0, 5);
    insights.push({
      title: 'Session momentum: active concepts when sessions close',
      body: [
        'These words appear most often as the last meaningful content before a session ends.',
        'They represent what is being worked on when work pauses — potential re-entry points.',
        '',
        top5.map(([w, c]) => `- "${w}": ${c} sessions`).join('\n'),
        '',
        'At session start, these are the concepts most worth surfacing to restore momentum.',
        '',
        `Source: ${source}.`,
      ].join('\n'),
      type:  'observation',
      tags:  ['attention', 'momentum', 'patterns', 'soma', 'continuity'],
    });
  }

  return insights;
}

// ---------------------------------------------------------------------------
// Small utils for generateInsights
// ---------------------------------------------------------------------------

function pct(n, total) {
  return total > 0 ? Math.round((n / total) * 100) : 0;
}

function sessionCharacter(avgMin) {
  if (avgMin >= 45) return 'deep work';
  if (avgMin >= 20) return 'focused sessions';
  return 'quick interactions';
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = { analyzeTranscripts, analyzeHistory, generateInsights };
