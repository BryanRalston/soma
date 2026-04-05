// soma.config.example.js
// Copy to soma.config.js and fill in your values

module.exports = {
  // Your name — used in briefings and journal entries
  userName: 'Your Name',

  // Base directory for Soma's data files
  home: process.env.SOMA_HOME || __dirname,
  dataDir: process.env.SOMA_DATA || __dirname + '/data',

  // Your projects — Soma will monitor these and track activity
  projectTags: [
    // Add your project codenames here
    // 'myapp', 'api', 'frontend'
  ],

  projects: [
    // Projects Soma can take autonomous action on (deploy, commit, etc.)
    // { id: 'myapp', path: '/path/to/myapp', githubRepo: 'username/myapp' }
  ],

  // Optional: A thought node ID to measure continuity accumulation around.
  // If set, continuity-tracker.js will measure how the KG density changes
  // around this node over time. Leave null if you don't need this.
  continuityTrackerId: null,

  sensors: {
    github: {
      // GitHub repos to monitor for issues, PRs, community activity
      // Accept strings ('username/repo') or objects ({ owner, repo })
      repos: [
        // 'username/repo-name'
      ],
      pollIntervalMs: 60 * 60 * 1000, // 1 hour
    },
    rss: {
      // RSS/Atom feeds relevant to your work
      feeds: [
        // { url: 'https://example.com/feed', tags: ['topic1', 'topic2'] }
      ],
      pollIntervalMs: 2 * 60 * 60 * 1000, // 2 hours
    },
    pubmed: {
      // Medical/research topics (optional — remove sensor if not needed)
      // Format: [{ name: 'topic-id', term: 'PubMed search string' }]
      // See: https://pubmed.ncbi.nlm.nih.gov/advanced/ for search syntax
      topics: [],
      enabled: false,
    }
  },

  llm: {
    // LLM configuration
    claude: {
      // Path to claude CLI binary (auto-detected if on PATH)
      // Leave as 'claude' to use whatever is on PATH
      bin: process.env.CLAUDE_BIN || 'claude',
    },
    grok: {
      // xAI API key for Grok fallback (optional)
      // If not set, only Claude will be used
      apiKey: process.env.XAI_API_KEY || null,
      // Path to grok-client.js if you have one (optional)
      // clientPath: '/path/to/grok-client.js',
    },
    // Cost escalation thresholds
    // free       = local KG reasoning (no tokens)
    // tactical   = fast LLM (Grok)
    // operational = capable LLM (Claude Sonnet)
    // strategic  = deep synthesis (Claude Opus)
    deepThinkModel: process.env.SOMA_DEEP_MODEL || 'sonnet',
  },

  // API authentication
  // Admin key: passed as X-Soma-Admin-Key header (or Bearer token)
  adminKey: 'change-me-in-production',
  // API keys for external integrations
  apiKeys: [
    // { key: 'sk-soma-...', name: 'my-claude-integration', userId: 'local', scopes: ['*'] }
  ],
  api: {
    port: 3001,
    // host: '0.0.0.0'  // uncomment to expose on network
  },

  safety: {
    // Minimum minutes since last user session before autonomous deep-think
    sessionBufferMinutes: 30,
    // Cooldown between deep-think cycles (minutes)
    deepThinkCooldownMinutes: 60,
    // Max deep-thinks per day
    maxDeepThinksPerDay: 4,
    // Memory threshold (%) above which deep-think is blocked
    memoryThresholdPercent: 78,
  }
};
