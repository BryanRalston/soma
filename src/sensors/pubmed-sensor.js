// ============================================================
// SOMA — PubMed Literature Sensor
// Monitors PubMed for recent publications on topics relevant
// to your active projects. Configure in soma.config.js:
//   sensors.pubmed.topics = [{ name: 'my-topic', term: '"MeSH Term"' }]
//
// Uses NCBI E-utilities (free tier, 3 req/s):
//   ESearch → PMIDs → EFetch → structured article records
//
// No npm dependencies — uses Node built-in https or global fetch.
// XML parsing is regex-based on structured MEDLINE records.
// ============================================================

const SensorBase = require('./sensor-base');

const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const TOOL_NAME = 'soma-literature-sensor';
const TOOL_EMAIL = 'soma@soma.local'; // NCBI requires identifying info — update to your email

// Rate limit: 350ms between requests (stays under 3 rps free tier)
const RATE_LIMIT_MS = 350;

// Queries configured via soma.config.js → sensors.pubmed.topics
// Format: [{ name: 'topic-id', term: 'PubMed search string' }]
// Example: [{ name: 'alzheimers', term: '"Alzheimer Disease"[MeSH]' }]
let _configTopics = [];
try {
  const cfg = require('../../soma.config.js');
  if (Array.isArray(cfg.sensors?.pubmed?.topics)) {
    _configTopics = cfg.sensors.pubmed.topics;
  }
} catch (_) {}
const QUERIES = _configTopics;

class PubMedSensor extends SensorBase {
  constructor(config = {}) {
    super('pubmed', config);
    this.seenPMIDs = new Set();       // Avoid reprocessing across runs
    this.lookbackDays = config.lookbackDays || 30;
    this.maxPerQuery = config.maxPerQuery || 50;
  }

  // TEMP: 1 hour for testing (normally 12 hours)
  get intervalMs() {
    return 1 * 60 * 60 * 1000; // TEMP: 1 hour (was 12)
  }

  // ── Fetch: query PubMed for recent articles ─────────────────

  async fetch() {
    const allResults = [];

    for (const query of QUERIES) {
      try {
        // Step 1: ESearch — get PMIDs
        const searchUrl = `${EUTILS_BASE}/esearch.fcgi?db=pubmed` +
          `&term=${encodeURIComponent(query.term)}` +
          `&retmode=json&retmax=${this.maxPerQuery}` +
          `&sort=most+recent&datetype=edat&reldate=${this.lookbackDays}` +
          `&tool=${TOOL_NAME}&email=${TOOL_EMAIL}`;

        const searchResult = await this._httpGet(searchUrl);
        const searchData = JSON.parse(searchResult);
        const pmids = searchData?.esearchresult?.idlist || [];

        if (pmids.length === 0) {
          continue;
        }

        // Filter out already-seen PMIDs
        const newPMIDs = pmids.filter(id => !this.seenPMIDs.has(id));
        if (newPMIDs.length === 0) {
          continue;
        }

        // Rate limit between requests
        await this._sleep(RATE_LIMIT_MS);

        // Step 2: EFetch — get full article records as XML
        const fetchUrl = `${EUTILS_BASE}/efetch.fcgi?db=pubmed` +
          `&id=${newPMIDs.join(',')}` +
          `&retmode=xml&rettype=abstract` +
          `&tool=${TOOL_NAME}&email=${TOOL_EMAIL}`;

        const xmlData = await this._httpGet(fetchUrl);

        allResults.push({ query: query.name, pmids: newPMIDs, xml: xmlData });

        // Rate limit before next query
        if (QUERIES.indexOf(query) < QUERIES.length - 1) {
          await this._sleep(RATE_LIMIT_MS);
        }
      } catch (err) {
        console.error(`[PubMed] Error fetching ${query.name}: ${err.message}`);
        this.lastError = `${query.name}: ${err.message}`;
      }
    }

    return allResults;
  }

  // ── Extract: parse XML into structured article objects ──────

  async extract(rawResults) {
    const articles = [];

    for (const result of rawResults) {
      if (!result.xml) continue;

      const parsed = this._parseArticles(result.xml, result.query);
      for (const article of parsed) {
        // Mark as seen so we skip on future runs
        this.seenPMIDs.add(article.pmid);
        articles.push(article);
      }
    }

    return articles;
  }

  // ── XML Parsing (regex-based on MEDLINE structure) ─────────

  _parseArticles(xml, queryName) {
    const articles = [];

    // Split into individual article blocks
    const articleBlocks = xml.split(/<PubmedArticle>/);
    // First element is header, skip it
    for (let i = 1; i < articleBlocks.length; i++) {
      const block = articleBlocks[i];
      try {
        const article = this._parseOneArticle(block, queryName);
        if (article) articles.push(article);
      } catch (err) {
        // Skip malformed articles silently
        console.error(`[PubMed] Parse error in article block: ${err.message}`);
      }
    }

    return articles;
  }

  _parseOneArticle(block, queryName) {
    const pmid = this._extractTag(block, 'PMID');
    if (!pmid) return null;

    const title = this._extractTag(block, 'ArticleTitle') || 'Untitled';

    // Abstract may have multiple AbstractText elements (structured abstracts)
    const abstractParts = this._extractAllTags(block, 'AbstractText');
    const abstract = abstractParts.join(' ').trim();

    // Authors
    const authors = [];
    const authorBlocks = block.split(/<Author /);
    for (let j = 1; j < authorBlocks.length; j++) {
      const lastName = this._extractTag(authorBlocks[j], 'LastName');
      const foreName = this._extractTag(authorBlocks[j], 'ForeName');
      if (lastName) {
        authors.push({ name: foreName ? `${foreName} ${lastName}` : lastName });
      }
    }

    // MeSH terms
    const meshTerms = this._extractAllDescriptorNames(block);

    // Keywords
    const keywords = this._extractAllTags(block, 'Keyword');

    // DOI
    const doi = this._extractDOI(block);

    // Publication date
    const pubDate = this._extractPubDate(block);

    // Journal
    const journal = this._extractTag(block, 'Title') || this._extractTag(block, 'ISOAbbreviation') || '';

    return {
      pmid,
      title: this._decodeEntities(title),
      abstract: this._decodeEntities(abstract),
      authors,
      meshTerms,
      keywords: keywords.map(k => this._decodeEntities(k)),
      doi,
      pubDate,
      journal: this._decodeEntities(journal),
      query: queryName
    };
  }

  // ── Tag extraction helpers ─────────────────────────────────

  _extractTag(text, tagName) {
    // Match <TagName ...>content</TagName>, handling attributes
    const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const match = text.match(regex);
    if (!match) return null;
    // Strip nested tags
    return match[1].replace(/<[^>]+>/g, '').trim();
  }

  _extractAllTags(text, tagName) {
    const results = [];
    const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
    let match;
    while ((match = regex.exec(text)) !== null) {
      const content = match[1].replace(/<[^>]+>/g, '').trim();
      if (content) results.push(content);
    }
    return results;
  }

  _extractAllDescriptorNames(text) {
    // MeSH terms live inside <MeshHeading><DescriptorName ...>Term</DescriptorName></MeshHeading>
    const results = [];
    const regex = /<DescriptorName[^>]*>([^<]+)<\/DescriptorName>/gi;
    let match;
    while ((match = regex.exec(text)) !== null) {
      results.push(match[1].trim());
    }
    return results;
  }

  _extractDOI(text) {
    // <ELocationID EIdType="doi" ...>10.xxxx/yyyy</ELocationID>
    const match = text.match(/<ELocationID\s+EIdType="doi"[^>]*>([^<]+)<\/ELocationID>/i);
    return match ? match[1].trim() : null;
  }

  _extractPubDate(text) {
    // Try <PubDate> block first
    const pubDateBlock = text.match(/<PubDate>([\s\S]*?)<\/PubDate>/i);
    if (!pubDateBlock) return null;

    const year = this._extractTag(pubDateBlock[1], 'Year');
    const month = this._extractTag(pubDateBlock[1], 'Month');
    const day = this._extractTag(pubDateBlock[1], 'Day');

    if (year) {
      // Month might be name or number
      const monthNum = this._parseMonth(month);
      return `${year}-${monthNum || '01'}-${(day || '01').padStart(2, '0')}`;
    }

    // Fallback: MedlineDate
    const medlineDate = this._extractTag(pubDateBlock[1], 'MedlineDate');
    return medlineDate || null;
  }

  _parseMonth(month) {
    if (!month) return null;
    const monthMap = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
                       jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
    const lower = month.toLowerCase().slice(0, 3);
    return monthMap[lower] || (month.length <= 2 ? month.padStart(2, '0') : null);
  }

  _decodeEntities(text) {
    if (!text) return text;
    return text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  // ── HTTP helpers ───────────────────────────────────────────

  async _httpGet(url) {
    // Use global fetch if available (Node 22+), fall back to https module
    if (typeof globalThis.fetch === 'function') {
      const response = await globalThis.fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.text();
    }

    // Fallback: Node https module
    return new Promise((resolve, reject) => {
      const https = require('https');
      const request = https.get(url, { timeout: 30000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume(); // consume response to free memory
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

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── State persistence ──────────────────────────────────────
  // Extend base to also persist seen PMIDs

  getState() {
    return {
      ...super.getState(),
      seenPMIDs: [...this.seenPMIDs]
    };
  }

  loadState(state) {
    super.loadState(state);
    if (state?.seenPMIDs) {
      this.seenPMIDs = new Set(state.seenPMIDs);
    }
  }
}

module.exports = PubMedSensor;
