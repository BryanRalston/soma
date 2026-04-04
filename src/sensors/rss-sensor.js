// ============================================================
// SOMA — RSS/Atom Feed Sensor
// Monitors RSS/Atom feeds relevant to your active projects.
//
// Configure feeds in soma.config.js → sensors.rss.feeds
// Handles both RSS 2.0 and Atom feed formats.
// XML parsing is regex-based — no npm dependencies.
// ============================================================

const SensorBase = require('./sensor-base');

// Feeds are configured via soma.config.js → sensors.rss.feeds
// Format: [{ url: 'https://...', tags: ['tag1', 'tag2'] }]
// or objects with name: { name: 'my-feed', url: '...', tags: [] }
const DEFAULT_FEEDS = [];

const FEED_TIMEOUT_MS = 15000;
const MAX_ITEMS_PER_FEED = 20;
const MAX_SEEN_IDS = 1000;
const SUMMARY_MAX_LENGTH = 500;

class RSSSensor extends SensorBase {
  constructor(config = {}) {
    super('rss', config);
    this.feeds = config.feeds || DEFAULT_FEEDS;
    this.seenIds = new Set();
    this.lastCheckedAt = {};  // per-feed: { feedName: timestamp }
  }

  get intervalMs() {
    return 2 * 60 * 60 * 1000; // 2 hours
  }

  // ── Fetch: pull XML from all configured feeds ─────────────

  async fetch() {
    const allResults = [];

    for (const feed of this.feeds) {
      try {
        const xml = await this._fetchFeed(feed.url);
        allResults.push({ feed, xml });
      } catch (err) {
        console.error(`[RSS] Error fetching ${feed.name} (${feed.url}): ${err.message}`);
        this.lastError = `${feed.name}: ${err.message}`;
        // Continue with remaining feeds — one bad feed shouldn't block the rest
      }
    }

    return allResults;
  }

  // ── Extract: parse XML into structured items ──────────────

  async extract(rawResults) {
    const allItems = [];

    for (const result of rawResults) {
      if (!result.xml) continue;

      try {
        const items = this._parseFeed(result.xml, result.feed);
        allItems.push(...items);
      } catch (err) {
        console.error(`[RSS] Parse error for ${result.feed.name}: ${err.message}`);
      }
    }

    return allItems;
  }

  // ── Feed Parsing ──────────────────────────────────────────

  _parseFeed(xml, feedConfig) {
    // Detect format: Atom feeds have <feed> root, RSS has <rss> or <channel>
    const isAtom = /<feed[\s>]/i.test(xml);

    const rawItems = isAtom
      ? this._parseAtomEntries(xml)
      : this._parseRSSItems(xml);

    const lastChecked = this.lastCheckedAt[feedConfig.name] || 0;
    const items = [];

    for (const raw of rawItems) {
      // Parse the publication date
      const pubDate = raw.pubDate ? new Date(raw.pubDate) : null;
      const pubTimestamp = pubDate && !isNaN(pubDate.getTime()) ? pubDate.getTime() : 0;

      // Skip items older than last check (if we have a lastChecked timestamp)
      if (lastChecked > 0 && pubTimestamp > 0 && pubTimestamp <= lastChecked) {
        continue;
      }

      // Build a unique ID from guid or link
      const itemId = raw.guid || raw.link || `${feedConfig.name}:${raw.title}`;

      // Skip already-seen items
      if (this.seenIds.has(itemId)) {
        continue;
      }

      // Strip HTML and truncate summary
      const summary = this._stripHtml(raw.description || '').slice(0, SUMMARY_MAX_LENGTH).trim();

      items.push({
        id: `rss:${feedConfig.name}:${itemId}`,
        feedName: feedConfig.name,
        title: this._stripHtml(raw.title || 'Untitled').trim(),
        link: raw.link || '',
        summary,
        pubDate: pubDate ? pubDate.toISOString() : null,
        categories: raw.categories || [],
        tags: [...(feedConfig.tags || [])]
      });

      // Mark as seen
      this.seenIds.add(itemId);

      // Cap per feed
      if (items.length >= MAX_ITEMS_PER_FEED) break;
    }

    // Update last checked timestamp for this feed
    this.lastCheckedAt[feedConfig.name] = Date.now();

    return items;
  }

  // ── RSS 2.0 Parser ────────────────────────────────────────

  _parseRSSItems(xml) {
    const items = [];
    const itemBlocks = xml.split(/<item[\s>]/i);

    // First element is the channel header, skip it
    for (let i = 1; i < itemBlocks.length; i++) {
      const block = itemBlocks[i];
      try {
        const title = this._extractTag(block, 'title');
        const link = this._extractTag(block, 'link');
        const description = this._extractTagContent(block, 'description');
        const pubDate = this._extractTag(block, 'pubDate');
        const guid = this._extractTag(block, 'guid');

        // Extract multiple <category> tags
        const categories = this._extractAllTags(block, 'category');

        items.push({ title, link, description, pubDate, guid, categories });
      } catch (err) {
        // Skip malformed items
        console.error(`[RSS] Malformed RSS item: ${err.message}`);
      }
    }

    return items;
  }

  // ── Atom Parser ───────────────────────────────────────────

  _parseAtomEntries(xml) {
    const entries = [];
    const entryBlocks = xml.split(/<entry[\s>]/i);

    // First element is the feed header, skip it
    for (let i = 1; i < entryBlocks.length; i++) {
      const block = entryBlocks[i];
      try {
        const title = this._extractTag(block, 'title');

        // Atom links use <link href="..."/> or <link href="..." rel="alternate"/>
        const link = this._extractAtomLink(block);

        // Prefer <summary>, fall back to <content>
        const description = this._extractTagContent(block, 'summary')
          || this._extractTagContent(block, 'content');

        // Atom uses <updated> or <published>
        const pubDate = this._extractTag(block, 'updated')
          || this._extractTag(block, 'published');

        const guid = this._extractTag(block, 'id');

        // Atom categories use <category term="..."/>
        const categories = this._extractAtomCategories(block);

        entries.push({ title, link, description, pubDate, guid, categories });
      } catch (err) {
        console.error(`[RSS] Malformed Atom entry: ${err.message}`);
      }
    }

    return entries;
  }

  // ── XML Extraction Helpers ────────────────────────────────

  _extractTag(text, tagName) {
    const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const match = text.match(regex);
    if (!match) return null;

    let content = match[1].trim();

    // Unwrap CDATA sections before stripping tags — otherwise the
    // <![CDATA[...]]> wrapper gets eaten by the tag-strip regex
    content = content.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

    // Strip nested HTML tags
    return content.replace(/<[^>]+>/g, '').trim();
  }

  _extractTagContent(text, tagName) {
    // Like _extractTag but preserves inner content (may contain CDATA or HTML)
    const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const match = text.match(regex);
    if (!match) return null;

    let content = match[1].trim();

    // Handle CDATA sections
    const cdataMatch = content.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    if (cdataMatch) {
      content = cdataMatch[1];
    }

    return content;
  }

  _extractAllTags(text, tagName) {
    const results = [];
    const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
    let match;
    while ((match = regex.exec(text)) !== null) {
      let content = match[1].trim();
      // Unwrap CDATA before stripping tags
      content = content.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
      content = content.replace(/<[^>]+>/g, '').trim();
      if (content) results.push(content);
    }
    return results;
  }

  _extractAtomLink(text) {
    // Try rel="alternate" first (the main article link)
    const altMatch = text.match(/<link[^>]*rel\s*=\s*["']alternate["'][^>]*href\s*=\s*["']([^"']+)["']/i);
    if (altMatch) return altMatch[1];

    // Fall back to any <link href="...">
    const hrefMatch = text.match(/<link[^>]*href\s*=\s*["']([^"']+)["']/i);
    return hrefMatch ? hrefMatch[1] : null;
  }

  _extractAtomCategories(text) {
    const categories = [];
    const regex = /<category[^>]*term\s*=\s*["']([^"']+)["']/gi;
    let match;
    while ((match = regex.exec(text)) !== null) {
      categories.push(match[1].trim());
    }
    return categories;
  }

  // ── HTML Stripping ────────────────────────────────────────

  _stripHtml(text) {
    if (!text) return '';

    // Remove CDATA wrappers
    text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

    // Decode HTML entities FIRST so escaped tags become real tags
    text = text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#x27;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));

    // Now remove all HTML tags (including those that were entity-encoded)
    text = text.replace(/<[^>]+>/g, ' ');

    // Second pass: catch any remaining &amp; from double-encoded content
    text = text.replace(/&amp;/g, '&');

    // Collapse whitespace
    text = text.replace(/\s+/g, ' ').trim();

    return text;
  }

  // ── HTTP Helper ───────────────────────────────────────────

  async _fetchFeed(url) {
    if (typeof globalThis.fetch === 'function') {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);

      try {
        const response = await globalThis.fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Soma-RSS-Sensor/1.0 (+https://github.com/soma-cognitive-engine/soma)',
            'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
          }
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.text();
      } finally {
        clearTimeout(timeout);
      }
    }

    // Fallback: Node https/http module
    return new Promise((resolve, reject) => {
      const proto = url.startsWith('https') ? require('https') : require('http');
      const request = proto.get(url, {
        timeout: FEED_TIMEOUT_MS,
        headers: {
          'User-Agent': 'Soma-RSS-Sensor/1.0 (+https://github.com/soma-cognitive-engine/soma)',
          'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
        }
      }, (res) => {
        // Follow redirects (301, 302, 307, 308)
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          this._fetchFeed(res.headers.location).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      });

      request.on('error', reject);
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Request timed out'));
      });
    });
  }

  // ── State Persistence ─────────────────────────────────────
  // Extend base to persist seenIds and per-feed timestamps.

  getState() {
    // Prune seenIds if over cap — keep the most recent
    let seenArray = [...this.seenIds];
    if (seenArray.length > MAX_SEEN_IDS) {
      seenArray = seenArray.slice(seenArray.length - MAX_SEEN_IDS);
    }

    return {
      ...super.getState(),
      seenIds: seenArray,
      lastCheckedAt: { ...this.lastCheckedAt }
    };
  }

  loadState(state) {
    super.loadState(state);
    if (state?.seenIds) {
      this.seenIds = new Set(state.seenIds);
    }
    if (state?.lastCheckedAt) {
      this.lastCheckedAt = { ...state.lastCheckedAt };
    }
  }
}

module.exports = RSSSensor;
