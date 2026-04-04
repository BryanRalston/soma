// ============================================================
// CLAUDE SESSION — Managed Claude CLI Session
// Soma opens these when it needs LLM help. Multi-turn.
// Not the brain. A resource the brain manages.
// ============================================================

const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const { acquireBackgroundLock, releaseBackgroundLock, isLockedBy } = require('./session-lock');

class ClaudeSession {
  constructor(options = {}) {
    this.id = options.id || ((() => {
      const uuid = crypto.randomUUID();
      const r = (options.reason || '').toLowerCase();
      if (r.includes('soma') || r.includes('think') || r.includes('deep') || r.includes('sensor') || r.includes('router')) {
        return 'soma-' + uuid;
      }
      return uuid;
    })());
    this.claudePath = options.claudePath || (() => {
      // Check config first
      let cfgBin = null;
      try { cfgBin = require('../../soma.config.js').llm?.claude?.bin; } catch (_) {}
      if (cfgBin && cfgBin !== 'claude') return cfgBin;

      // Cross-platform auto-detection
      const isWindows = process.platform === 'win32';
      if (isWindows) {
        const localBin = path.join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe');
        const npmBin = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');
        if (fs.existsSync(localBin)) return localBin;
        if (fs.existsSync(npmBin)) return npmBin;
        return 'claude.exe';
      } else {
        // Unix/macOS
        const localBin = path.join(process.env.HOME || '', '.local', 'bin', 'claude');
        const npmBin = path.join(process.env.HOME || '', '.npm-global', 'bin', 'claude');
        if (fs.existsSync(localBin)) return localBin;
        if (fs.existsSync(npmBin)) return npmBin;
        return 'claude';
      }
    })();
    this.timeout = options.timeout || 120000;          // 2 min per message
    this.sessionTimeout = options.sessionTimeout || 300000; // 5 min total session
    this.model = options.model || 'sonnet';
    this.systemPrompt = options.systemPrompt || null;

    let _cfgHome = null;
    try { _cfgHome = require('../../soma.config.js').home; } catch (_) {}
    this.cwd = options.cwd || _cfgHome || process.cwd();

    this.messageCount = 0;
    this.startedAt = null;
    this.lastMessageAt = null;
    this.totalTokensEstimate = 0;
    this.active = false;
    this.reason = options.reason || 'unknown';
    this.log = [];
    this.lockHolder = options.lockHolder || this._inferLockHolder();
    this.ownsLock = false;
  }

  // Infer lock holder name from reason string
  _inferLockHolder() {
    const r = (this.reason || '').toLowerCase();
    if (r.includes('soma') || r.includes('think')) return 'soma';
    if (r.includes('action') || r.includes('router') || r.includes('pipeline')) return 'action-router';
    return 'soma'; // default for background sessions
  }

  // Open the session with an initial prompt. Uses --session-id for first message.
  // Checks session lock before spawning claude.exe.
  async open(initialPrompt) {
    // Check if someone else holds the lock
    const lockCheck = isLockedBy(this.lockHolder);
    if (lockCheck.locked) {
      throw new Error(`Claude session blocked — ${lockCheck.reason}. Skipping spawn.`);
    }

    // Acquire the background lock for ourselves
    const result = acquireBackgroundLock(this.lockHolder);
    if (!result.acquired) {
      throw new Error(`Could not acquire session lock: ${result.reason}`);
    }
    this.ownsLock = true;

    this.startedAt = Date.now();
    this.active = true;
    return this._send(initialPrompt, true);
  }

  // Send a follow-up message. Uses --resume. Throws if session not active or timed out.
  async send(prompt) {
    if (!this.active) throw new Error('Session not active');
    if (Date.now() - this.startedAt > this.sessionTimeout) {
      await this.close();
      throw new Error('Session timed out');
    }
    return this._send(prompt, false);
  }

  // Internal: spawn claude CLI and collect response.
  // Pipes prompt through stdin to avoid Windows command-line length limits.
  async _send(prompt, isFirst) {
    const args = ['-p', '--output-format', 'text', '--dangerously-skip-permissions'];

    if (this.model) args.push('--model', this.model);

    if (isFirst) {
      args.push('--session-id', this.id);
      if (this.systemPrompt) {
        args.push('--append-system-prompt', this.systemPrompt);
      }
    } else {
      args.push('--resume', this.id);
    }

    const sendStart = Date.now();

    return new Promise((resolve, reject) => {
      // Clean env — remove CLAUDECODE so nested sessions work
      // Remove any BUN_JSC_ vars — they're unstable internals that break between Bun versions
      const cleanEnv = { ...process.env };
      delete cleanEnv.CLAUDECODE;
      delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
      // Purge all BUN_JSC_ vars to avoid "invalid JSC environment variable" errors
      for (const key of Object.keys(cleanEnv)) {
        if (key.startsWith('BUN_JSC_')) delete cleanEnv[key];
      }

      const proc = spawn(this.claudePath, args, {
        timeout: this.timeout,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.cwd,
        env: cleanEnv
      });

      // Pipe prompt through stdin — no command-line length limit
      proc.stdin.write(prompt);
      proc.stdin.end();

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        this.messageCount++;
        this.lastMessageAt = Date.now();
        const elapsed = this.lastMessageAt - sendStart;
        const tokens = Math.ceil((prompt.length + stdout.length) / 4);
        this.totalTokensEstimate += tokens;

        this.log.push({
          messageNum: this.messageCount,
          prompt: prompt.slice(0, 200),
          responsePreview: stdout.trim().slice(0, 200),
          responseLength: stdout.length,
          tokensEstimate: tokens,
          elapsed,
          code
        });

        if (code !== 0) {
          reject(new Error(`Claude session message failed (code ${code}): ${stderr.slice(0, 500)}`));
        } else {
          resolve({
            text: stdout.trim(),
            messageNum: this.messageCount,
            tokensEstimate: tokens,
            elapsed
          });
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Claude session spawn error: ${err.message}`));
      });
    });
  }

  // Close the session. Releases lock. Returns a summary object.
  async close() {
    this.active = false;

    // Release our background lock if we own it
    if (this.ownsLock) {
      releaseBackgroundLock(this.lockHolder);
      this.ownsLock = false;
    }

    return {
      sessionId: this.id,
      reason: this.reason,
      messages: this.messageCount,
      duration: this.startedAt ? Date.now() - this.startedAt : 0,
      totalTokensEstimate: this.totalTokensEstimate,
      log: this.log
    };
  }

  // Current status snapshot
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

module.exports = { ClaudeSession };
