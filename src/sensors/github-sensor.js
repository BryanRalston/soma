// ============================================================
// SOMA — GitHub Community Sensor
// Monitors GitHub repos for community activity:
// issues, PRs, stars, forks, and security advisories.
//
// Uses GitHub REST API (unauthenticated — 60 req/hr).
// Configure repos in soma.config.js → sensors.github.repos
//
// No npm dependencies — uses Node built-in fetch.
// ============================================================

const SensorBase = require('./sensor-base');

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'soma-github-sensor';

// Repos are configured via soma.config.js → sensors.github.repos
// Format: [{ owner: 'username', repo: 'repo-name' }]
// or strings: ['username/repo-name'] (parsed automatically)
const DEFAULT_REPOS = [];

function parseRepoConfig(repos) {
  if (!Array.isArray(repos)) return [];
  return repos.map(r => {
    if (typeof r === 'string') {
      const [owner, repo] = r.split('/');
      return { owner, repo };
    }
    return r;
  }).filter(r => r.owner && r.repo);
}

class GitHubSensor extends SensorBase {
  constructor(config = {}) {
    super('github', config);
    const configuredRepos = config.repos || DEFAULT_REPOS;
    this.repos = parseRepoConfig(configuredRepos);
    this.lookbackHours = config.lookbackHours || 168; // 1 week
    this.lastCheckedAt = {};        // { "owner/repo": ISO timestamp }
    this.seenEventIds = new Set();  // Avoid reprocessing events
    this.rateLimitRemaining = 60;   // Track across requests in a cycle
  }

  get intervalMs() {
    return 60 * 60 * 1000; // 1 hour
  }

  // ── Fetch: query GitHub for recent activity ─────────────────

  async fetch() {
    const allResults = [];

    for (const { owner, repo } of this.repos) {
      const repoKey = `${owner}/${repo}`;

      // Bail early if rate limit is low
      if (this.rateLimitRemaining < 5) {
        console.log(`[GitHub] Rate limit low (${this.rateLimitRemaining} remaining) — stopping early`);
        break;
      }

      try {
        // Determine the "since" timestamp
        const since = this.lastCheckedAt[repoKey]
          || new Date(Date.now() - this.lookbackHours * 60 * 60 * 1000).toISOString();

        // Step 1: Recent issues (includes PRs)
        const issuesUrl = `${GITHUB_API}/repos/${owner}/${repo}/issues` +
          `?state=all&sort=updated&since=${since}&per_page=30`;

        const issuesData = await this._apiGet(issuesUrl);
        if (issuesData === null) continue; // 404 or rate limited

        // Step 2: Recent events
        const eventsUrl = `${GITHUB_API}/repos/${owner}/${repo}/events?per_page=30`;
        const eventsData = await this._apiGet(eventsUrl);

        // Step 3: Security advisories (may need auth — skip gracefully)
        let advisoriesData = null;
        try {
          const advisoriesUrl = `${GITHUB_API}/repos/${owner}/${repo}/vulnerability-alerts`;
          advisoriesData = await this._apiGet(advisoriesUrl);
        } catch (_) {
          // Expected to fail without auth — silently skip
        }

        // Update last checked timestamp for this repo
        this.lastCheckedAt[repoKey] = new Date().toISOString();

        allResults.push({
          owner,
          repo,
          repoKey,
          issues: Array.isArray(issuesData) ? issuesData : [],
          events: Array.isArray(eventsData) ? eventsData : [],
          advisories: advisoriesData
        });

      } catch (err) {
        console.error(`[GitHub] Error fetching ${repoKey}: ${err.message}`);
        this.lastError = `${repoKey}: ${err.message}`;
      }
    }

    return allResults;
  }

  // ── Extract: transform raw API data into structured items ───

  async extract(rawResults) {
    const items = [];

    for (const result of rawResults) {
      const { owner, repo, repoKey } = result;

      // Extract issues and PRs
      for (const issue of result.issues) {
        const isPR = !!issue.pull_request;
        const type = isPR ? 'pr' : 'issue';
        const id = `github:${repo}:${type}:${issue.number}`;

        items.push({
          id,
          repo: repoKey,
          type,
          title: issue.title || 'Untitled',
          body: (issue.body || '').slice(0, 500),
          user: issue.user?.login || 'unknown',
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          url: issue.html_url,
          labels: (issue.labels || []).map(l => l.name),
          state: issue.state,
          comments: issue.comments || 0
        });
      }

      // Extract events — filter owner PushEvents and deduplicate
      const filteredEvents = this._filterAndDeduplicateEvents(result.events, owner, repoKey);
      for (const event of filteredEvents) {
        const eventId = event.id || event._syntheticId;
        if (eventId && this.seenEventIds.has(eventId)) continue;

        const mapped = this._mapEvent(event, repoKey);
        if (mapped) {
          items.push(mapped);
        }
      }
    }

    return items;
  }

  // ── Filter and Deduplicate Events ─────────────────────────
  // 1. Drop PushEvents from the repo owner (deployment noise)
  // 2. Collapse consecutive PushEvents from the same user into one

  _filterAndDeduplicateEvents(events, repoOwner, repoKey) {
    if (!Array.isArray(events)) return [];

    // Step 1: Filter out owner PushEvents (deployment pushes, not community signal)
    const filtered = events.filter(event => {
      if (event.type !== 'PushEvent') return true;
      const actor = event.actor?.login || '';
      return actor.toLowerCase() !== repoOwner.toLowerCase();
    });

    // Step 2: Collapse consecutive PushEvents from the same user+repo
    const collapsed = [];
    let pushRun = null; // { user, repoKey, events: [], totalCommits: 0 }

    for (const event of filtered) {
      const actor = event.actor?.login || 'unknown';

      if (event.type === 'PushEvent') {
        if (pushRun && pushRun.user === actor && pushRun.repoKey === repoKey) {
          // Same user, same repo — accumulate
          pushRun.events.push(event);
          pushRun.totalCommits += (event.payload?.size || 0);
        } else {
          // Flush previous run if any
          if (pushRun) {
            collapsed.push(this._collapsePushRun(pushRun));
          }
          // Start new run
          pushRun = {
            user: actor,
            repoKey,
            events: [event],
            totalCommits: event.payload?.size || 0
          };
        }
      } else {
        // Non-push event — flush any accumulated push run first
        if (pushRun) {
          collapsed.push(this._collapsePushRun(pushRun));
          pushRun = null;
        }
        collapsed.push(event);
      }
    }

    // Flush final push run
    if (pushRun) {
      collapsed.push(this._collapsePushRun(pushRun));
    }

    return collapsed;
  }

  // Collapse a run of PushEvents into a single synthetic event
  _collapsePushRun(run) {
    if (run.events.length === 1) {
      return run.events[0]; // No collapsing needed for single events
    }

    // Collect all event IDs so we mark them all as seen
    const allIds = run.events.map(e => e.id).filter(Boolean);

    // Gather commit messages from all events (up to 5)
    const allCommits = run.events
      .flatMap(e => e.payload?.commits || [])
      .slice(0, 5);

    return {
      _syntheticId: `push-collapse:${run.repoKey}:${run.user}:${allIds[0]}`,
      _collapsedIds: allIds,
      type: 'PushEvent',
      actor: { login: run.user },
      created_at: run.events[0].created_at,
      payload: {
        size: run.totalCommits,
        commits: allCommits,
        _pushCount: run.events.length
      }
    };
  }

  // ── Event Mapping ───────────────────────────────────────────

  _mapEvent(event, repoKey) {
    const repo = repoKey.split('/')[1];
    const base = {
      repo: repoKey,
      user: event.actor?.login || 'unknown',
      createdAt: event.created_at,
      updatedAt: event.created_at,
      url: `https://github.com/${repoKey}`,
      labels: [],
      state: null
    };

    switch (event.type) {
      case 'WatchEvent':
        // GitHub API calls stars "WatchEvent"
        this.seenEventIds.add(event.id);
        return {
          ...base,
          id: `github:${repo}:star:${event.id}`,
          type: 'star',
          title: `${base.user} starred ${repoKey}`,
          body: ''
        };

      case 'ForkEvent':
        this.seenEventIds.add(event.id);
        return {
          ...base,
          id: `github:${repo}:fork:${event.id}`,
          type: 'fork',
          title: `${base.user} forked ${repoKey}`,
          body: event.payload?.forkee?.full_name
            ? `Forked to ${event.payload.forkee.full_name}`
            : '',
          url: event.payload?.forkee?.html_url || base.url
        };

      case 'IssuesEvent':
        this.seenEventIds.add(event.id);
        return {
          ...base,
          id: `github:${repo}:event:${event.id}`,
          type: 'event',
          title: `Issue ${event.payload?.action}: ${event.payload?.issue?.title || 'unknown'}`,
          body: (event.payload?.issue?.body || '').slice(0, 500),
          url: event.payload?.issue?.html_url || base.url,
          state: event.payload?.action
        };

      case 'PullRequestEvent':
        this.seenEventIds.add(event.id);
        return {
          ...base,
          id: `github:${repo}:event:${event.id}`,
          type: 'event',
          title: `PR ${event.payload?.action}: ${event.payload?.pull_request?.title || 'unknown'}`,
          body: (event.payload?.pull_request?.body || '').slice(0, 500),
          url: event.payload?.pull_request?.html_url || base.url,
          state: event.payload?.action
        };

      case 'CreateEvent':
        this.seenEventIds.add(event.id);
        return {
          ...base,
          id: `github:${repo}:event:${event.id}`,
          type: 'event',
          title: `Created ${event.payload?.ref_type || 'ref'}: ${event.payload?.ref || repoKey}`,
          body: event.payload?.description || ''
        };

      case 'PushEvent': {
        // Mark all IDs as seen (handles collapsed multi-push events)
        if (event._collapsedIds) {
          event._collapsedIds.forEach(id => this.seenEventIds.add(id));
        }
        if (event.id) this.seenEventIds.add(event.id);
        if (event._syntheticId) this.seenEventIds.add(event._syntheticId);

        const commitCount = event.payload?.size || 0;
        const pushCount = event.payload?._pushCount || 1;

        // Build descriptive title — mention push count if collapsed
        let pushTitle;
        if (pushCount > 1) {
          pushTitle = `${base.user} pushed ${pushCount} times to ${repoKey} (${commitCount} commit${commitCount !== 1 ? 's' : ''})`;
        } else {
          pushTitle = `${base.user} pushed ${commitCount} commit${commitCount !== 1 ? 's' : ''} to ${repoKey}`;
        }

        return {
          ...base,
          id: `github:${repo}:event:${event._syntheticId || event.id}`,
          type: 'event',
          title: pushTitle,
          body: (event.payload?.commits || [])
            .slice(0, 3)
            .map(c => c.message)
            .join('; ')
        };
      }

      default:
        // Skip event types we don't care about
        return null;
    }
  }

  // ── HTTP helper with rate limit tracking ────────────────────

  async _apiGet(url) {
    try {
      const response = await globalThis.fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      // Track rate limit from response headers
      const remaining = response.headers.get('X-RateLimit-Remaining');
      if (remaining !== null) {
        this.rateLimitRemaining = parseInt(remaining, 10);
      }

      // Rate limited — stop
      if (response.status === 403 && this.rateLimitRemaining <= 0) {
        const resetAt = response.headers.get('X-RateLimit-Reset');
        const resetDate = resetAt ? new Date(parseInt(resetAt, 10) * 1000).toISOString() : 'unknown';
        console.warn(`[GitHub] Rate limited. Resets at ${resetDate}`);
        this.lastError = `Rate limited until ${resetDate}`;
        return null;
      }

      // Not found — repo may not exist or endpoint needs auth
      if (response.status === 404) {
        console.warn(`[GitHub] 404 for ${url} — skipping`);
        return null;
      }

      if (!response.ok) {
        console.warn(`[GitHub] HTTP ${response.status} for ${url}`);
        return null;
      }

      return await response.json();
    } catch (err) {
      console.error(`[GitHub] Fetch error: ${err.message}`);
      return null;
    }
  }

  // ── State persistence ──────────────────────────────────────
  // Persist lastCheckedAt per repo and seenEventIds across restarts

  getState() {
    // Cap seenEventIds at 500 — prune oldest (Sets iterate in insertion order)
    let eventIds = [...this.seenEventIds];
    if (eventIds.length > 500) {
      eventIds = eventIds.slice(eventIds.length - 500);
    }

    return {
      ...super.getState(),
      lastCheckedAt: this.lastCheckedAt,
      seenEventIds: eventIds
    };
  }

  loadState(state) {
    super.loadState(state);
    if (state?.lastCheckedAt) {
      this.lastCheckedAt = state.lastCheckedAt;
    }
    if (state?.seenEventIds) {
      this.seenEventIds = new Set(state.seenEventIds);
    }
  }
}

module.exports = GitHubSensor;
