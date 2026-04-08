// ============================================================
// mcp.js — Soma MCP Server
// Exposes Soma's cognitive capabilities to any MCP-compatible AI assistant.
//
// Usage:
//   claude mcp add soma --transport http http://localhost:3001/mcp \
//     --header "Authorization: Bearer your-api-key"
//
// If no API keys are configured in soma.config.js, the MCP endpoint is open
// (localhost-only by default). Once apiKeys or adminKey are set, a valid
// Bearer token is required.
//
// Mount:
//   const { createMcpServer } = require('./mcp');
//   const { setupRoutes } = createMcpServer(engine);
//   setupRoutes(app);  // before app.listen()
// ============================================================

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const fs = require('fs');
const path = require('path');
const { requireApiKey } = require('./auth');

let _config = {};
try { _config = require('../../soma.config.js'); } catch (_) {}
const DATA_DIR = process.env.SOMA_DATA || _config.dataDir || path.join(__dirname, '../../data');
const NARRATIVES_FILE = path.join(DATA_DIR, 'session_narratives.json');

// ── Session transport map (stateful per Mcp-Session-Id) ───────
const transports = new Map(); // sessionId -> StreamableHTTPServerTransport

// ── Narrative helper ─────────────────────────────────────────

function appendNarrative(entry) {
  let narratives = [];
  try {
    if (fs.existsSync(NARRATIVES_FILE)) {
      narratives = JSON.parse(fs.readFileSync(NARRATIVES_FILE, 'utf8'));
      if (!Array.isArray(narratives)) narratives = [];
    }
  } catch (_) {}
  narratives.push(entry);
  const tmp = NARRATIVES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(narratives, null, 2), 'utf8');
  fs.renameSync(tmp, NARRATIVES_FILE);
}

// ── Briefing text helper ─────────────────────────────────────

function buildBriefingText(briefing) {
  let text = `Soma Briefing — ${briefing.timeSince || 'unknown'} since last session\n\n`;
  for (const section of (briefing.sections || [])) {
    text += `## ${section.title}\n${section.summary}\n`;
    if (section.highlights?.length) {
      text += section.highlights.map(h => `  - ${h}`).join('\n') + '\n';
    }
    text += '\n';
  }
  return text;
}

// ── Context text helper ──────────────────────────────────────

function buildContextText(engine) {
  const state = engine.self ? engine.self.currentState() : {};
  const activeGoals = (engine.goals || []).filter(g => g.status === 'active');

  let openQuestions = [];
  try {
    openQuestions = engine.kg.query({ type: 'question' }).slice(0, 10)
      .concat(engine.kg.query({ type: 'hypothesis' }).slice(0, 5))
      .map(n => n.title || n.id);
  } catch (_) {}

  let text = `Soma Context\n\n`;
  text += `State: ${state.mood || 'unknown'} | Confidence: ${(state.confidence || 0).toFixed(2)}\n`;
  text += `Knowledge: ${state.knowledge?.nodes || 0} nodes, ${state.knowledge?.edges || 0} edges\n\n`;

  if (activeGoals.length > 0) {
    text += `## Active Goals\n`;
    for (const g of activeGoals) {
      text += `  - [${g.horizon || 'unknown'}] ${g.title}\n`;
    }
    text += '\n';
  }

  if (openQuestions.length > 0) {
    text += `## Open Questions\n`;
    for (const q of openQuestions) {
      text += `  - ${q}\n`;
    }
    text += '\n';
  }

  const router = engine.router;
  if (router) {
    try {
      const stats = router.getStats ? router.getStats() : null;
      if (stats) {
        text += `## Routing Stats\n`;
        text += `  LLM calls: ${stats.llmCalls || 0} | Composer: ${stats.composerCalls || 0}\n\n`;
      }
    } catch (_) {}
  }

  if (engine.context?.focus) {
    text += `## Current Focus\n  ${engine.context.focus}\n\n`;
  }

  return text;
}

// ── Per-session McpServer factory ────────────────────────────
// McpServer can only connect to one transport at a time.
// Each MCP session gets its own McpServer instance with tools registered.

function createSessionServer(engine, sessionLock) {
  const mcpServer = new McpServer({
    name: 'soma',
    version: '1.0.0'
  });

  // ── Tool: soma_briefing ──────────────────────────────────────
  mcpServer.tool(
    'soma_briefing',
    'Get a briefing of everything Soma has learned, discovered, and flagged since your last session. Call this at the start of every session.',
    {
      format: z.enum(['structured', 'text']).default('text'),
      sections: z.string().optional().describe('Comma-separated sections to include: knowledge,insights,goals,learning,attention')
    },
    async ({ format, sections }) => {
      if (!engine.briefing) {
        return { content: [{ type: 'text', text: 'Briefing system not initialized.' }] };
      }
      const briefing = engine.briefing.generate();

      let result = briefing;
      if (sections) {
        const wanted = sections.split(',').map(s => s.trim().toLowerCase());
        result = {
          ...briefing,
          sections: (briefing.sections || []).filter(s =>
            wanted.some(w => (s.title || '').toLowerCase().includes(w))
          )
        };
      }

      if (format === 'text') {
        return { content: [{ type: 'text', text: buildBriefingText(result) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Tool: soma_query ─────────────────────────────────────────
  mcpServer.tool(
    'soma_query',
    'Query Soma\'s knowledge graph. Ask what Soma knows about a topic, person, project, or concept.',
    {
      q: z.string().describe('What to search for'),
      limit: z.number().default(5)
    },
    async ({ q, limit }) => {
      const results = engine.hybridSearch(q, limit);
      if (!results || results.length === 0) {
        return { content: [{ type: 'text', text: `No results found for: "${q}"` }] };
      }
      const lines = results.map((r, i) => {
        const node = r.node || r;
        const title = node.title || node.id || '(untitled)';
        const body = (node.body || '').slice(0, 120);
        const score = (r.score || r.relevance || 0).toFixed(2);
        return `${i + 1}. [${score}] ${title}${body ? `\n   ${body}` : ''}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n\n') }] };
    }
  );

  // ── Tool: soma_observe ───────────────────────────────────────
  mcpServer.tool(
    'soma_observe',
    'Add an observation, insight, decision, or discovery to Soma\'s knowledge graph. Use this to capture anything worth remembering.',
    {
      title: z.string(),
      body: z.string().optional(),
      type: z.enum(['observation', 'insight', 'hypothesis', 'decision', 'question', 'correction']).default('observation'),
      tags: z.array(z.string()).optional(),
      project: z.string().optional()
    },
    async ({ title, body, type, tags, project }) => {
      const node = engine.addKnowledge({
        type,
        title,
        body: body || '',
        metadata: {
          tags: tags || [],
          project: project || null,
          source: 'mcp',
          confidence: 0.9
        }
      });
      engine.save();
      return {
        content: [{
          type: 'text',
          text: `Observation recorded.\nID: ${node.id || 'unknown'}\nType: ${type}\nTitle: ${title}`
        }]
      };
    }
  );

  // ── Tool: soma_context ───────────────────────────────────────
  mcpServer.tool(
    'soma_context',
    'Get Soma\'s current focus: active goals, warm reasoning threads, open questions, and routing stats. Use this to understand what Soma is currently thinking about.',
    {},
    async () => {
      const text = buildContextText(engine);
      return { content: [{ type: 'text', text }] };
    }
  );

  // ── Tool: soma_register_session ──────────────────────────────
  mcpServer.tool(
    'soma_register_session',
    'Register the current AI session with Soma. Call at session start. Returns a session ID to use with soma_end_session.',
    {
      project: z.string().optional(),
      context: z.string().optional().describe('Brief description of what this session is working on')
    },
    async ({ project, context }) => {
      const id = `s-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const session = sessionLock.registerSession(id, process.pid, project || 'mcp-session');
      return {
        content: [{
          type: 'text',
          text: `Session registered.\nID: ${session.id}\nProject: ${session.project}${context ? `\nContext: ${context}` : ''}\n\nUse this ID with soma_end_session when done.`
        }]
      };
    }
  );

  // ── Tool: soma_end_session ───────────────────────────────────
  mcpServer.tool(
    'soma_end_session',
    'End the current session and submit a narrative of what happened. This feeds Soma\'s episodic memory and is how it learns from your work.',
    {
      sessionId: z.string(),
      title: z.string(),
      body: z.string().describe('Prose summary of the session — what happened, what was decided, what was discovered'),
      project: z.string().optional(),
      decisions: z.array(z.string()).optional(),
      discoveries: z.array(z.string()).optional()
    },
    async ({ sessionId, title, body, project, decisions, discoveries }) => {
      sessionLock.unregisterSession(sessionId);

      const entry = {
        id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        sessionId,
        timestamp: Date.now(),
        title,
        body,
        project: project || null,
        decisions: decisions || [],
        discoveries: discoveries || [],
        source: 'mcp'
      };

      appendNarrative(entry);

      // Async consolidation — don't block the response
      if (engine.consolidator?.processNewSessions) {
        engine.consolidator.processNewSessions().catch(err => {
          console.error('[Soma MCP] Consolidator error:', err.message);
        });
      }

      return {
        content: [{
          type: 'text',
          text: `Session ended and narrative saved.\nNarrative ID: ${entry.id}\nTitle: ${title}`
        }]
      };
    }
  );

  // ── Resource: soma://briefing ────────────────────────────────
  mcpServer.resource(
    'soma://briefing',
    'soma://briefing',
    { mimeType: 'text/plain', name: 'Soma Briefing', description: 'Current briefing from Soma — what happened since last session' },
    async () => {
      if (!engine.briefing) {
        return { contents: [{ uri: 'soma://briefing', mimeType: 'text/plain', text: 'Briefing system not initialized.' }] };
      }
      const briefing = engine.briefing.generate();
      return {
        contents: [{
          uri: 'soma://briefing',
          mimeType: 'text/plain',
          text: buildBriefingText(briefing)
        }]
      };
    }
  );

  // ── Resource: soma://context ─────────────────────────────────
  mcpServer.resource(
    'soma://context',
    'soma://context',
    { mimeType: 'text/plain', name: 'Soma Context', description: 'Soma\'s current focus, active goals, and reasoning threads' },
    async () => {
      return {
        contents: [{
          uri: 'soma://context',
          mimeType: 'text/plain',
          text: buildContextText(engine)
        }]
      };
    }
  );

  return mcpServer;
}

// ── Main factory ─────────────────────────────────────────────

function createMcpServer(engine) {
  const sessionLock = require('../tools/session-lock');

  function setupRoutes(app) {
    // POST /mcp — main JSON-RPC handler
    // Each new session gets its own McpServer+transport pair
    app.post('/mcp', requireApiKey, async (req, res) => {
      const sessionId = req.headers['mcp-session-id'];

      let transport;
      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId);
      } else {
        // New session — create a fresh McpServer instance + transport
        const mcpServer = createSessionServer(engine, sessionLock);

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => {
            const id = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            transports.set(id, transport);
            return id;
          }
        });

        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };

        await mcpServer.connect(transport);
      }

      try {
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        console.error('[Soma MCP] Request error:', err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'MCP request failed', message: err.message });
        }
      }
    });

    // GET /mcp — SSE stream for server-initiated messages
    app.get('/mcp', requireApiKey, async (req, res) => {
      const sessionId = req.headers['mcp-session-id'];
      if (!sessionId || !transports.has(sessionId)) {
        res.status(400).json({ error: 'No active session. Send POST /mcp first.' });
        return;
      }
      try {
        await transports.get(sessionId).handleRequest(req, res);
      } catch (err) {
        console.error('[Soma MCP] SSE error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'SSE failed', message: err.message });
      }
    });

    // DELETE /mcp — clean up session
    app.delete('/mcp', requireApiKey, (req, res) => {
      const sessionId = req.headers['mcp-session-id'];
      if (sessionId && transports.has(sessionId)) {
        transports.get(sessionId).close?.();
        transports.delete(sessionId);
      }
      res.status(200).json({ ok: true });
    });

    console.log('[Soma MCP] Routes mounted at /mcp (POST, GET, DELETE)');
    console.log('[Soma MCP] Connect with: claude mcp add soma --transport http http://localhost:3001/mcp \\');
    console.log('[Soma MCP]   --header "Authorization: Bearer your-api-key"');
  }

  return { setupRoutes };
}

module.exports = { createMcpServer };
