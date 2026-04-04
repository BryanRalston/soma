// ============================================================
// SOMA CORE — LLM Tool
// Claude (or any LLM) as a pluggable tool.
// Not the brain. A capability the brain can call.
// ============================================================

const { execSync, spawn } = require('child_process');

function createLLMTool(options = {}) {
  const claudePath = options.claudePath || 'claude';
  const timeout = options.timeout || 60000;
  const defaultModel = options.model || null; // optional model tier override (e.g. 'sonnet', 'opus')

  return {
    name: 'llm',
    description: 'Large language model for natural language generation and complex reasoning',
    category: 'llm',
    cost: 'expensive',
    capabilities: [
      'natural-language-generation',
      'complex-reasoning',
      'summarization',
      'code-generation',
      'analysis',
      'conversation'
    ],

    available: () => {
      // Don't shell out to check — just report based on config
      // The actual availability is tested on first use
      return options.assumeAvailable ?? true;
    },

    fallback: 'composer',   // Fall back to template-based composition

    execute: async (input, context = {}) => {
      const { prompt, systemPrompt, maxTokens, model: inputModel } = typeof input === 'string'
        ? { prompt: input }
        : input;

      if (!prompt) throw new Error('LLM tool requires a prompt');

      // Resolve model: per-call override > tool-level default > none (CLI default)
      const resolvedModel = inputModel || defaultModel || null;

      // Build the command
      const args = ['-p', prompt, '--output-format', 'text'];

      if (resolvedModel) {
        args.push('--model', resolvedModel);
      }

      if (systemPrompt) {
        args.push('--system', systemPrompt);
      }

      if (maxTokens) {
        args.push('--max-tokens', String(maxTokens));
      }

      return new Promise((resolve, reject) => {
        const proc = spawn(claudePath, args, {
          timeout,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: true
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`LLM tool failed (code ${code}): ${stderr}`));
          } else {
            resolve({
              text: stdout.trim(),
              tokensUsed: estimateTokens(prompt + stdout),
              source: 'claude-cli'
            });
          }
        });

        proc.on('error', (err) => {
          reject(new Error(`LLM tool spawn error: ${err.message}`));
        });
      });
    }
  };
}

// ── Fallback Composer Tool ────────────────────────────────────
// When LLM is unavailable, use the engine's own composer

function createComposerTool(composer) {
  return {
    name: 'composer',
    description: 'Template-based response composition from knowledge graph',
    category: 'llm',
    cost: 'free',
    capabilities: [
      'structured-response',
      'knowledge-retrieval',
      'status-report',
      'pattern-report'
    ],

    available: () => true,

    execute: async (input) => {
      const { prompt, type } = typeof input === 'string'
        ? { prompt: input, type: 'question-answer' }
        : input;

      if (type === 'question-answer' || !type) {
        return {
          text: composer.answerFromKnowledge(prompt),
          tokensUsed: 0,
          source: 'soma-composer'
        };
      }

      return {
        text: composer.compose({ type, data: input.data || {}, query: prompt }),
        tokensUsed: 0,
        source: 'soma-composer'
      };
    }
  };
}

// ── Web Search Tool ───────────────────────────────────────────

function createWebSearchTool() {
  return {
    name: 'web-search',
    description: 'Search the web for information',
    category: 'search',
    cost: 'cheap',
    capabilities: ['web-search', 'current-information', 'fact-checking'],

    available: () => {
      try {
        execSync('curl --version', { timeout: 3000, stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    },

    execute: async (input) => {
      const query = typeof input === 'string' ? input : input.query;
      // Use DuckDuckGo instant answer API (no API key needed)
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;

      return new Promise((resolve, reject) => {
        const { exec } = require('child_process');
        exec(`curl -s "${url}"`, { timeout: 10000 }, (err, stdout) => {
          if (err) return reject(new Error(`Web search failed: ${err.message}`));
          try {
            const data = JSON.parse(stdout);
            resolve({
              text: data.AbstractText || data.Answer || 'No direct answer found',
              source: data.AbstractSource || 'DuckDuckGo',
              relatedTopics: (data.RelatedTopics || []).slice(0, 5).map(t => t.Text).filter(Boolean),
              url: data.AbstractURL || null
            });
          } catch (e) {
            resolve({ text: 'Search returned unparseable results', source: 'error' });
          }
        });
      });
    }
  };
}

// ── File System Tool ──────────────────────────────────────────

function createFileSystemTool() {
  const fs = require('fs');
  const path = require('path');

  return {
    name: 'filesystem',
    description: 'Read and search local files',
    category: 'filesystem',
    cost: 'free',
    capabilities: ['file-read', 'file-search', 'file-list'],

    available: () => true,

    execute: async (input) => {
      const { action, path: filePath, pattern, content } = input;

      switch (action) {
        case 'read':
          if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
          return { text: fs.readFileSync(filePath, 'utf8'), source: filePath };

        case 'list':
          if (!fs.existsSync(filePath)) throw new Error(`Directory not found: ${filePath}`);
          return { text: fs.readdirSync(filePath).join('\n'), source: filePath };

        case 'search':
          // Simple recursive file search
          const results = [];
          const search = (dir, depth = 0) => {
            if (depth > 5) return;
            try {
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              for (const entry of entries) {
                if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                  search(full, depth + 1);
                } else if (!pattern || entry.name.match(new RegExp(pattern, 'i'))) {
                  results.push(full);
                }
              }
            } catch {}
          };
          search(filePath || '.');
          return { text: results.join('\n'), files: results };

        default:
          throw new Error(`Unknown filesystem action: ${action}`);
      }
    }
  };
}

// ── Token Estimation ──────────────────────────────────────────

function estimateTokens(text) {
  // Rough estimate: ~4 chars per token for English
  return Math.ceil((text || '').length / 4);
}

module.exports = {
  createLLMTool,
  createComposerTool,
  createWebSearchTool,
  createFileSystemTool
};
