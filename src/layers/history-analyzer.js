'use strict';

/**
 * history-analyzer.js
 * Mines Claude session history and feeds working patterns
 * into Soma's attention tracking and thoughtstream systems.
 *
 * Usage: node history-analyzer.js [--no-post]
 *   --no-post   Run analysis only, skip posting to Cortex APIs
 */

const fs = require('fs');
const readline = require('readline');
const path = require('path');
const http = require('http');

let _config = {};
try { _config = require('../../soma.config.js'); } catch (_) {}
const DATA_DIR = process.env.SOMA_DATA || _config.dataDir || path.join(__dirname, '../../data');

// Default: ~/.claude/history.jsonl (Claude CLI history file)
const HISTORY_FILE = process.env.SOMA_HISTORY_FILE ||
  path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'history.jsonl');
const OUTPUT_FILE = path.join(DATA_DIR, 'history_analysis.json');

// ---------------------------------------------------------------------------
// HOST SERVER DEPENDENCY NOTE
// ---------------------------------------------------------------------------
// This module optionally posts analysis results (thoughtstream entries,
// attention events) to a host web server layer that exposes the Soma/Cortex
// REST API (e.g., the Cortex Command Center at web/server.js).
//
// In standalone Soma (without a host web layer), this module is OPTIONAL:
//   - Run with `--no-post` to perform analysis only, skipping all HTTP posts.
//   - If the server is unreachable, each post call is caught and logged as
//     SKIPPED — the analysis itself still completes and writes to disk.
//
// Server location is configurable via environment variables or soma.config.js:
//   SOMA_HOST   — hostname of the host web server  (default: 'localhost')
//   SOMA_PORT   — port of the host web server       (default: 3142)
//
// In soma.config.js:
//   module.exports = { port: 3142, server: { host: 'localhost', port: 3142 } }
// ---------------------------------------------------------------------------

// Soma API server (if running alongside a web server for thoughtstream posting)
const SOMA_HOST = process.env.SOMA_HOST || _config.server?.host || 'localhost';
const SOMA_PORT = parseInt(process.env.SOMA_PORT || _config.server?.port || _config.port || 3142, 10);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveProjectName(projectPath) {
  if (!projectPath) return 'global';

  const normalized = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');

  // If this is the Soma home directory, return 'global'
  let somaHome = '';
  try { somaHome = require('../../soma.config.js').home || ''; } catch (_) {}
  if (somaHome) {
    const normalizedHome = somaHome.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized === normalizedHome || normalized.startsWith(normalizedHome + '/')) {
      return 'soma';
    }
  }

  const parts = normalized.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'global';
}

function parseTimestamp(ts) {
  // ts is epoch ms
  return new Date(ts);
}

function postJson(urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: SOMA_HOST,
      port: SOMA_PORT,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error('Request timed out'));
    });
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

async function analyzeHistory() {
  const byProject = {};   // projectName → { messages, sessions: Set, firstSeen, lastSeen }
  const byHour = {};      // 0-23 → count
  const byDayOfWeek = {}; // 0-6 → count
  const allSessions = new Set();
  const sessionLengths = {}; // sessionId → { first, last }

  let totalMessages = 0;
  let firstTimestamp = Infinity;
  let lastTimestamp = -Infinity;

  // Initialize hour/day buckets
  for (let i = 0; i < 24; i++) byHour[i] = 0;
  for (let i = 0; i < 7; i++) byDayOfWeek[i] = 0;

  const fileStream = fs.createReadStream(HISTORY_FILE, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed lines
    }

    const { timestamp, project: projectPath, sessionId } = entry;
    if (!timestamp) continue;

    const dt = parseTimestamp(timestamp);
    const ts = timestamp;

    totalMessages++;

    // Time range
    if (ts < firstTimestamp) firstTimestamp = ts;
    if (ts > lastTimestamp) lastTimestamp = ts;

    // Hour of day (local)
    const hour = dt.getHours();
    byHour[hour] = (byHour[hour] || 0) + 1;

    // Day of week (0=Sunday)
    const dow = dt.getDay();
    byDayOfWeek[dow] = (byDayOfWeek[dow] || 0) + 1;

    // Session tracking
    if (sessionId) {
      allSessions.add(sessionId);
      if (!sessionLengths[sessionId]) {
        sessionLengths[sessionId] = { first: ts, last: ts, count: 0 };
      }
      if (ts < sessionLengths[sessionId].first) sessionLengths[sessionId].first = ts;
      if (ts > sessionLengths[sessionId].last) sessionLengths[sessionId].last = ts;
      sessionLengths[sessionId].count++;
    }

    // Project bucketing
    const projectName = deriveProjectName(projectPath);
    if (!byProject[projectName]) {
      byProject[projectName] = {
        messages: 0,
        sessions: new Set(),
        firstSeen: ts,
        lastSeen: ts,
        rawPath: projectPath || null,
      };
    }
    const proj = byProject[projectName];
    proj.messages++;
    if (sessionId) proj.sessions.add(sessionId);
    if (ts < proj.firstSeen) proj.firstSeen = ts;
    if (ts > proj.lastSeen) proj.lastSeen = ts;
  }

  // ---------------------------------------------------------------------------
  // Compute derived stats
  // ---------------------------------------------------------------------------

  const sessionCount = allSessions.size;

  // Average session length in minutes.
  // Cap at 240 min (4h) to exclude sessions that span multiple days / calendar gaps.
  const MAX_SESSION_MIN = 240;
  const rawDurations = Object.values(sessionLengths)
    .filter((s) => s.last > s.first)
    .map((s) => (s.last - s.first) / 60000);
  const durations = rawDurations.filter((d) => d <= MAX_SESSION_MIN);
  const avgSessionLength =
    durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;

  // Longest single-sitting session (capped set)
  const longestSession =
    durations.length > 0 ? Math.round(Math.max(...durations)) : 0;

  // Longest uncapped (informational)
  const longestRaw =
    rawDurations.length > 0 ? Math.round(Math.max(...rawDurations)) : 0;

  // Top projects (sorted by messages)
  const projectList = Object.entries(byProject)
    .map(([name, data]) => ({
      name,
      messages: data.messages,
      sessions: data.sessions.size,
      firstSeen: new Date(data.firstSeen).toISOString(),
      lastSeen: new Date(data.lastSeen).toISOString(),
      pct: totalMessages > 0 ? Math.round((data.messages / totalMessages) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.messages - a.messages);

  const topProjects = projectList.slice(0, 10);

  // Peak hour
  const peakHour = parseInt(
    Object.entries(byHour).sort((a, b) => b[1] - a[1])[0][0],
    10
  );

  // Peak day of week
  const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const peakDow = parseInt(
    Object.entries(byDayOfWeek).sort((a, b) => b[1] - a[1])[0][0],
    10
  );

  // Messages per session per project (serialize Sets)
  const byProjectSerialized = {};
  for (const [name, data] of Object.entries(byProject)) {
    byProjectSerialized[name] = {
      messages: data.messages,
      sessions: data.sessions.size,
      firstSeen: new Date(data.firstSeen).toISOString(),
      lastSeen: new Date(data.lastSeen).toISOString(),
    };
  }

  const analysis = {
    generatedAt: new Date().toISOString(),
    totalMessages,
    sessionCount,
    dateRange: {
      first: new Date(firstTimestamp).toISOString(),
      last: new Date(lastTimestamp).toISOString(),
      spanDays: Math.round((lastTimestamp - firstTimestamp) / 86400000),
    },
    byProject: byProjectSerialized,
    byHour,
    byDayOfWeek,
    topProjects,
    peakHour,
    peakDow,
    peakDowName: DOW_NAMES[peakDow],
    avgSessionLength,
    longestSession,
    longestRawSession: longestRaw,
    messagesPerSession: sessionCount > 0 ? Math.round(totalMessages / sessionCount) : 0,
  };

  return analysis;
}

// ---------------------------------------------------------------------------
// Pretty CLI report
// ---------------------------------------------------------------------------

function formatHour(h) {
  if (h === 0) return '12am';
  if (h < 12) return `${h}am`;
  if (h === 12) return '12pm';
  return `${h - 12}pm`;
}

function printReport(analysis) {
  const {
    totalMessages,
    sessionCount,
    dateRange,
    topProjects,
    peakHour,
    peakDowName,
    avgSessionLength,
    longestSession,
    messagesPerSession,
    byHour,
  } = analysis;

  const bar = (count, max, width = 20) => {
    const filled = Math.round((count / max) * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
  };

  console.log('\n' + '═'.repeat(60));
  console.log('  CORTEX HISTORY ANALYSIS');
  console.log('═'.repeat(60));

  console.log(`\n  Date range : ${dateRange.first.slice(0, 10)} → ${dateRange.last.slice(0, 10)} (${dateRange.spanDays} days)`);
  console.log(`  Messages   : ${totalMessages.toLocaleString()}`);
  console.log(`  Sessions   : ${sessionCount.toLocaleString()}`);
  console.log(`  Avg/session: ${messagesPerSession} messages, ${avgSessionLength}min`);
  console.log(`  Longest    : ${longestSession} min`);

  console.log('\n  TOP PROJECTS\n  ' + '─'.repeat(56));
  topProjects.forEach((p, i) => {
    const label = `${String(i + 1).padStart(2)}. ${p.name}`.padEnd(28);
    const msgs = String(p.messages).padStart(5);
    const pct = `${p.pct}%`.padStart(6);
    console.log(`  ${label} ${msgs} msgs ${pct}`);
  });

  console.log('\n  ACTIVITY BY HOUR (local time)\n  ' + '─'.repeat(56));
  const blockCounts = [
    [0, 6], [6, 12], [12, 18], [18, 24],
  ].map(([start, end]) =>
    Object.entries(byHour)
      .filter(([h]) => parseInt(h) >= start && parseInt(h) < end)
      .reduce((s, [, c]) => s + c, 0)
  );
  const maxBlock = Math.max(...blockCounts);
  [[0, 6], [6, 12], [12, 18], [18, 24]].forEach(([start, end], idx) => {
    const label = `${formatHour(start)}–${formatHour(end)}`;
    const count = blockCounts[idx];
    console.log(`  ${label.padEnd(12)} ${bar(count, maxBlock)} ${count}`);
  });

  // Peak hour detail
  console.log(`\n  Peak hour: ${formatHour(peakHour)} (${byHour[peakHour]} messages)`);
  console.log(`  Peak day : ${peakDowName}`);

  console.log('\n' + '═'.repeat(60) + '\n');
}

// ---------------------------------------------------------------------------
// Post to Cortex APIs
// ---------------------------------------------------------------------------

async function postToCortex(analysis) {
  const { totalMessages, sessionCount, topProjects, peakHour, dateRange } = analysis;
  const top3 = topProjects.slice(0, 3).map((p) => `${p.name} (${p.messages})`).join(', ');
  const peakStr = formatHour(peakHour);

  console.log('  Posting to Cortex APIs...');

  // 1. Thoughtstream entry
  const thoughtBody = [
    `Analyzed ${totalMessages.toLocaleString()} messages across ${sessionCount} sessions spanning ${dateRange.spanDays} days.`,
    '',
    `Top projects by message count: ${top3}.`,
    `Peak activity hour: ${peakStr} local time.`,
    `Average session: ${analysis.messagesPerSession} messages, ${analysis.avgSessionLength} min.`,
    `Longest session on record: ${analysis.longestSession} min.`,
    '',
    `Full breakdown in data/history_analysis.json.`,
  ].join('\n');

  try {
    const thoughtRes = await postJson('/api/cortex/thoughtstream', {
      type: 'observation',
      title: 'Working pattern analysis from session history',
      body: thoughtBody,
      tags: ['attention', 'patterns', 'soma', 'history'],
      maturity: 'seed',
    });
    console.log(`  Thoughtstream: ${thoughtRes.status === 200 || thoughtRes.status === 201 ? 'OK' : 'FAILED (' + thoughtRes.status + ')'}`);
  } catch (err) {
    console.log(`  Thoughtstream: SKIPPED (${err.message})`);
  }

  // 2. Attention event
  try {
    const attnRes = await postJson('/api/cortex/attention/event', {
      type: 'history_analysis',
      summary: `Analyzed ${sessionCount} sessions across ${topProjects.length} projects. Peak activity: ${peakStr}. Top project: ${topProjects[0]?.name ?? 'unknown'}.`,
      data: {
        topProjects: topProjects.slice(0, 10),
        peakHour: analysis.peakHour,
        peakDowName: analysis.peakDowName,
        totalMessages,
        sessionCount,
        avgSessionLength: analysis.avgSessionLength,
        longestSession: analysis.longestSession,
        dateRange,
      },
    });
    console.log(`  Attention event: ${attnRes.status === 200 || attnRes.status === 201 ? 'OK' : 'FAILED (' + attnRes.status + ')'}`);
  } catch (err) {
    console.log(`  Attention event: SKIPPED (${err.message})`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const noPost = process.argv.includes('--no-post');

  console.log('  Streaming history file...');
  const analysis = await analyzeHistory();

  // Save JSON
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(analysis, null, 2), 'utf8');
  console.log(`  Saved → ${OUTPUT_FILE}`);

  // Print report
  printReport(analysis);

  // Post to Soma API (if available)
  if (!noPost) {
    await postToCortex(analysis);
    console.log('');
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
