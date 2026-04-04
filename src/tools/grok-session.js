// ============================================================
// GROK SESSION — Managed xAI Grok Session
// Mirrors the ClaudeSession interface exactly.
// Used as a fallback when Claude is unavailable or token budget
// is exhausted. Stateless HTTP calls — no CLI to spawn.
// ============================================================

const crypto = require('crypto');
const path = require('path');

// Resolve grok-client relative to this file's location.
// Expected at: <soma-root>/grok-client.js or configure via soma.config.js
let _grokClientPath = null;
try {
  const cfg = require('../../soma.config.js');
  if (cfg.llm?.grok?.clientPath) _grokClientPath = cfg.llm.grok.clientPath;
} catch (_) {}
const GROK_CLIENT_PATH = _grokClientPath || path.join(__dirname, '..', '..', 'grok-client.js');
const { streamGrokChat } = require(GROK_CLIENT_PATH);

const DEFAULT_MODEL = 'grok-3-mini';

class GrokSession {
  constructor(options = {}) {
    this.id = options.id || ('grok-' + crypto.randomUUID());
    this.timeout = options.timeout || 120000;          // 2 min per message
    this.sessionTimeout = options.sessionTimeout || 300000; // 5 min total session
    this.model = options.model || DEFAULT_MODEL;
    this.systemPrompt = options.systemPrompt || null;

    this.messageCount = 0;
    this.startedAt = null;
    this.lastMessageAt = null;
    this.totalTokensEstimate = 0;
    this.active = false;
    this.reason = options.reason || 'unknown';
    this.log = [];

    // Conversation history — Grok is stateless so we maintain it ourselves
    this._messages = [];

    // GrokSession never acquires the session lock (no claude.exe involved).
    // These stubs keep callers that inspect ownsLock from breaking.
    this.ownsLock = false;
    this.lockHolder = null;
  }

  // Open the session with an initial prompt.
  // Matches ClaudeSession.open() signature and return shape.
  async open(initialPrompt) {
    if (!process.env.XAI_API_KEY) {
      throw new Error('GrokSession: XAI_API_KEY environment variable is not set');
    }

    this.startedAt = Date.now();
    this.active = true;
    return this._send(initialPrompt);
  }

  // Send a follow-up message. Throws if session not active or timed out.
  // Matches ClaudeSession.send() signature.
  async send(prompt) {
    if (!this.active) throw new Error('GrokSession not active');
    if (Date.now() - this.startedAt > this.sessionTimeout) {
      await this.close();
      throw new Error('GrokSession timed out');
    }
    return this._send(prompt);
  }

  // Internal: call xAI API with accumulated conversation history.
  async _send(prompt) {
    const sendStart = Date.now();

    // Build message list: optional system prompt + history + new user message
    const messages = [];
    if (this.systemPrompt && this._messages.length === 0) {
      // Inject system prompt as a user-turn prefix on first message only,
      // since xAI's OpenAI-compat layer accepts a 'system' role.
      messages.push({ role: 'system', content: this.systemPrompt });
    }
    messages.push(...this._messages);
    messages.push({ role: 'user', content: prompt });

    let responseText = '';

    try {
      responseText = await streamGrokChat({
        messages,
        model: this.model,
        temperature: 0.7,
        onDelta: () => {},   // no streaming output needed for daemon use
        onDone: () => {},
        onError: () => {}
      });
    } catch (err) {
      // Re-throw with context so daemon can distinguish Grok errors
      throw new Error(`GrokSession API error: ${err.message}`);
    }

    // Record the assistant reply so follow-up turns have context
    this._messages.push({ role: 'user', content: prompt });
    this._messages.push({ role: 'assistant', content: responseText });

    this.messageCount++;
    this.lastMessageAt = Date.now();
    const elapsed = this.lastMessageAt - sendStart;
    const tokens = Math.ceil((prompt.length + responseText.length) / 4);
    this.totalTokensEstimate += tokens;

    this.log.push({
      messageNum: this.messageCount,
      prompt: prompt.slice(0, 200),
      responsePreview: responseText.trim().slice(0, 200),
      responseLength: responseText.length,
      tokensEstimate: tokens,
      elapsed,
      code: 0
    });

    return {
      text: responseText.trim(),
      messageNum: this.messageCount,
      tokensEstimate: tokens,
      elapsed
    };
  }

  // Close the session. Returns a summary object matching ClaudeSession.close().
  async close() {
    this.active = false;
    this._messages = [];
    return {
      sessionId: this.id,
      reason: this.reason,
      messages: this.messageCount,
      duration: this.startedAt ? Date.now() - this.startedAt : 0,
      totalTokensEstimate: this.totalTokensEstimate,
      log: this.log
    };
  }

  // Current status snapshot — matches ClaudeSession.status().
  status() {
    return {
      id: this.id,
      active: this.active,
      reason: this.reason,
      messages: this.messageCount,
      uptime: this.startedAt ? Date.now() - this.startedAt : 0,
      lastMessage: this.lastMessageAt,
      tokensEstimate: this.totalTokensEstimate
    };
  }
}

module.exports = { GrokSession };
