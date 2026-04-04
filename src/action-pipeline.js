// ============================================================
// SOMA — Action Pipeline
// The bridge between sensing and doing.
//
// Architecture:
//   Phase 1: Assessment (zero tokens) — runs in daemon cycle,
//     detects gaps in resource sites, queues confirmed actions.
//   Phase 2: Execution (may use tokens) — runs during daemon's
//     "alone time" (safety gate open), does the actual work:
//     updating pages, committing, pushing to GitHub Pages.
//
// Projects are configured via soma.config.js → projects array:
//   [{ id: 'my-site', path: '/path/to/site', githubRepo: 'user/repo' }]
//
// Queue file: data/action_queue.json
// ============================================================

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { addNotification } = require('./tools/session-lock');

let _config = {};
try { _config = require('../../soma.config.js'); } catch (_) {}

const DEFAULT_QUEUE_FILE = path.join(_config.dataDir || path.join(__dirname, '../../data'), 'action_queue.json');

class ActionPipeline {
  constructor(options = {}) {
    this.queueFile = options.queueFile || DEFAULT_QUEUE_FILE;
    this.queue = [];

    // Build projectPaths map from config.projects array
    // Each entry: { id: 'my-project', path: '/absolute/path' }
    const configuredProjects = (_config.projects || options.projects || []);
    this.projectPaths = {};
    for (const proj of configuredProjects) {
      if (proj.id && proj.path) {
        this.projectPaths[proj.id] = proj.path;
      }
    };
    // Cache parsed nav pages per project to avoid re-reading every cycle
    this._navCache = new Map();
    this._navCacheAge = new Map();
    this._navCacheTTL = 10 * 60 * 1000; // 10 minutes
  }

  // ── Persistence ────────────────────────────────────────────

  async load() {
    try {
      const raw = await fs.readFile(this.queueFile, 'utf8');
      const data = JSON.parse(raw);
      this.queue = Array.isArray(data.queue) ? data.queue : [];
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.queue = [];
      } else {
        console.error(`[ActionPipeline] Load error: ${err.message}`);
        this.queue = [];
      }
    }
  }

  async save() {
    try {
      const data = {
        lastSaved: Date.now(),
        count: this.queue.length,
        queue: this.queue
      };
      await fs.writeFile(this.queueFile, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`[ActionPipeline] Save error: ${err.message}`);
    }
  }

  // ── Phase 1: Assessment (zero tokens) ──────────────────────
  // Called from daemon cycle after sensors run.
  // For each high-relevance intake item, determine which project
  // it relates to, check if the topic is already covered, and
  // queue an action if a gap is found.

  async assess(intakeItems) {
    const results = { assessed: 0, gapsFound: 0, queued: 0, skipped: 0 };

    for (const item of intakeItems) {
      // Skip items we've already queued
      if (this.queue.some(a => a.intakeId === item.id)) {
        results.skipped++;
        continue;
      }

      const project = this._mapToProject(item);
      if (!project) {
        results.skipped++;
        continue;
      }

      const projectPath = this.projectPaths[project];
      if (!projectPath || !fsSync.existsSync(projectPath)) {
        results.skipped++;
        continue;
      }

      results.assessed++;

      try {
        // Extract keywords from the intake item
        const keywords = this._extractKeywords(item);
        if (keywords.length === 0) {
          results.skipped++;
          continue;
        }

        // Check coverage against the site's existing pages
        const coverage = await this._checkCoverage(project, keywords);

        const action = {
          id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          intakeId: item.id,
          type: 'notify-only', // default, upgraded below
          status: 'assessed',
          project,
          assessment: {
            hasGap: !coverage.covered,
            gapDescription: coverage.covered
              ? 'Topic already covered'
              : `Missing coverage for: ${coverage.gapKeywords.join(', ')}`,
            existingPages: coverage.coveringPages,
            recommendation: '',
            confidence: 0
          },
          execution: null,
          source: {
            sensor: item.source,
            title: item.data?.title || 'Unknown',
            relevance: item.relevanceScore
          },
          createdAt: Date.now(),
          updatedAt: Date.now()
        };

        if (!coverage.covered) {
          results.gapsFound++;

          // Determine action type and recommendation
          if (coverage.coveringPages.length > 0) {
            // Topic is partially covered — add reference to existing pages
            action.type = 'update-resource';
            action.assessment.recommendation = `Add reference to "${item.data?.title}" on: ${coverage.coveringPages.join(', ')}`;
            action.assessment.confidence = 0.7;
          } else {
            // Topic not covered at all — notify, don't create pages without Claude
            action.type = 'notify-only';
            action.assessment.recommendation = `New topic not covered on site: ${keywords.slice(0, 5).join(', ')}. Consider creating a new page.`;
            action.assessment.confidence = 0.4;
          }
        } else {
          // Already covered — check if this specific paper is referenced
          action.assessment.recommendation = 'Topic area covered. Paper may add new evidence.';
          action.assessment.confidence = 0.3;
          // Still queue as update-resource if we have covering pages
          // (the specific paper might not be cited even if the topic is)
          if (coverage.coveringPages.length > 0 && item.relevanceScore >= 0.4) {
            action.type = 'update-resource';
            action.assessment.recommendation = `Consider adding reference to "${item.data?.title}" on: ${coverage.coveringPages.slice(0, 3).join(', ')}`;
            action.assessment.confidence = 0.5;
          }
        }

        this.queue.push(action);
        results.queued++;

      } catch (err) {
        console.error(`[ActionPipeline] Assessment error for ${item.id}: ${err.message}`);
      }
    }

    if (results.queued > 0) {
      await this.save();
    }

    return results;
  }

  // ── Phase 2: Execution (may use tokens) ────────────────────
  // Called when safety gate is open. Processes queued actions.
  // For v1, only handles 'update-resource' by adding study
  // references to existing pages.

  async execute(options = {}) {
    const maxActions = options.maxActions || 5;
    const dryRun = options.dryRun || false;
    const results = { executed: 0, committed: 0, errors: 0 };

    // Get assessed actions that have gaps and are of type 'update-resource'
    const actionable = this.queue
      .filter(a => a.status === 'assessed' && a.type === 'update-resource' && a.assessment?.hasGap !== false)
      .slice(0, maxActions);

    if (actionable.length === 0) {
      return results;
    }

    console.log(`[ActionPipeline] Executing ${actionable.length} action(s)...`);

    // Group actions by project to batch git operations
    const byProject = new Map();
    for (const action of actionable) {
      if (!byProject.has(action.project)) {
        byProject.set(action.project, []);
      }
      byProject.get(action.project).push(action);
    }

    for (const [project, actions] of byProject) {
      const projectPath = this.projectPaths[project];
      if (!projectPath) continue;

      const changedFiles = [];

      for (const action of actions) {
        action.status = 'executing';
        action.updatedAt = Date.now();

        try {
          const filesModified = await this._executeAction(action, projectPath, dryRun);

          if (filesModified.length > 0) {
            changedFiles.push(...filesModified);
            action.execution = {
              filesChanged: filesModified,
              commitHash: null,
              commitMessage: null,
              pushed: false,
              error: null
            };
            action.status = 'completed';
            results.executed++;
          } else {
            // No changes made — file structure unexpected or already up to date
            action.status = 'completed';
            action.execution = {
              filesChanged: [],
              commitHash: null,
              commitMessage: null,
              pushed: false,
              error: 'No changes needed'
            };
          }
        } catch (err) {
          action.status = 'failed';
          action.execution = {
            filesChanged: [],
            commitHash: null,
            commitMessage: null,
            pushed: false,
            error: err.message
          };
          results.errors++;
          console.error(`[ActionPipeline] Execute error for ${action.id}: ${err.message}`);
        }

        action.updatedAt = Date.now();
      }

      // Git commit and push for all changes in this project
      if (changedFiles.length > 0 && !dryRun) {
        try {
          const uniqueFiles = [...new Set(changedFiles)];
          const titles = actions
            .filter(a => a.status === 'completed' && a.execution?.filesChanged?.length > 0)
            .map(a => a.source.title)
            .slice(0, 3);

          const commitMsg = titles.length === 1
            ? `Add reference: ${this._truncate(titles[0], 60)} (via Soma sensor)`
            : `Add ${titles.length} study references (via Soma sensor)`;

          const gitResult = await this._gitCommitAndPush(projectPath, uniqueFiles, commitMsg);

          // Update all completed actions with git info
          for (const action of actions) {
            if (action.execution && action.execution.filesChanged?.length > 0) {
              action.execution.commitHash = gitResult.hash;
              action.execution.commitMessage = commitMsg;
              action.execution.pushed = gitResult.pushed;
            }
          }

          results.committed++;
          console.log(`[ActionPipeline] Committed ${uniqueFiles.length} file(s) to ${project}: ${gitResult.hash}`);

          // Notify
          addNotification('soma-actions',
            `Updated ${project}: ${commitMsg}${gitResult.pushed ? ' (pushed)' : ' (local only)'}`,
            'info'
          );

        } catch (err) {
          console.error(`[ActionPipeline] Git error for ${project}: ${err.message}`);
          // Mark actions as failed for git
          for (const action of actions) {
            if (action.execution && action.execution.filesChanged?.length > 0) {
              action.execution.error = `Git failed: ${err.message}`;
              action.execution.pushed = false;
            }
          }
          results.errors++;

          addNotification('soma-actions',
            `Git failed for ${project}: ${err.message}`,
            'warning'
          );
        }
      }

      // Handle notify-only actions
      const notifyActions = actions.filter(a => a.type === 'notify-only' && a.status === 'assessed');
      for (const action of notifyActions) {
        action.status = 'completed';
        action.updatedAt = Date.now();
        addNotification('soma-actions',
          `[${project}] ${action.assessment.recommendation}`,
          'info'
        );
      }
    }

    await this.save();
    return results;
  }

  // ── Execute a single action ────────────────────────────────

  async _executeAction(action, projectPath, dryRun) {
    const filesModified = [];

    if (action.type !== 'update-resource') {
      return filesModified;
    }

    // For each covering page, try to add a reference
    const pages = action.assessment.existingPages || [];
    if (pages.length === 0) return filesModified;

    const paperData = await this._getIntakePaperData(action);
    if (!paperData) return filesModified;

    for (const relPagePath of pages.slice(0, 2)) { // Cap at 2 pages per action
      const fullPath = path.join(projectPath, relPagePath);

      try {
        const content = await fs.readFile(fullPath, 'utf8');
        const updated = this._insertReference(content, paperData);

        if (updated && updated !== content) {
          if (!dryRun) {
            await fs.writeFile(fullPath, updated, 'utf8');
          }
          filesModified.push(relPagePath);
        }
      } catch (err) {
        console.error(`[ActionPipeline] Failed to update ${relPagePath}: ${err.message}`);
      }
    }

    return filesModified;
  }

  // ── Get paper data from the intake item ────────────────────

  async _getIntakePaperData(action) {
    // The intake item's data should have title, authors, journal, pubDate, doi, pmid
    // We need to reconstruct this from the action's source + queue info
    // The intake buffer stores the full data object

    // Try to read from the action's linked intake data
    // (The intake buffer persists the full data object)
    try {
      const bufferFile = path.join(_config.dataDir || path.join(__dirname, '../../data'), 'intake_buffer.json');
      const raw = await fs.readFile(bufferFile, 'utf8');
      const data = JSON.parse(raw);
      const items = Array.isArray(data.items) ? data.items : [];
      const item = items.find(i => i.id === action.intakeId);

      if (item?.data) {
        const d = item.data;
        return {
          title: d.title || action.source.title || 'Untitled',
          authors: d.authors || [],
          journal: d.journal || '',
          pubDate: d.pubDate || '',
          doi: d.doi || '',
          pmid: d.pmid || '',
          abstract: d.abstract || ''
        };
      }
    } catch (err) {
      // Fall back to action source data
    }

    // Fallback: minimal data from action
    return {
      title: action.source.title || 'Untitled',
      authors: [],
      journal: '',
      pubDate: '',
      doi: '',
      pmid: '',
      abstract: ''
    };
  }

  // ── Insert a reference into an HTML page ───────────────────
  // Looks for a references/further reading section and appends.
  // If none found, tries to insert before the closing </main> or </body>.

  _insertReference(htmlContent, paper) {
    // Build the reference HTML
    const authorStr = this._formatAuthors(paper.authors);
    const year = paper.pubDate ? paper.pubDate.slice(0, 4) : '';
    const doiLink = paper.doi
      ? `<a href="https://doi.org/${paper.doi}" target="_blank" rel="noopener">DOI</a>`
      : '';
    const pmidLink = paper.pmid
      ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/" target="_blank" rel="noopener">PubMed</a>`
      : '';
    const links = [doiLink, pmidLink].filter(Boolean).join(' | ');

    // Clean title: remove trailing period if present (we add our own)
    const cleanTitle = this._escapeHtml(paper.title).replace(/\.\s*$/, '');
    const journalStr = paper.journal
      ? ` <em>${this._escapeHtml(paper.journal)}</em>.`
      : '';

    const refHtml = `        <li>${authorStr}${year ? `(${year})` : ''}. "${cleanTitle}."${journalStr}${links ? ' ' + links : ''}</li>`;

    // Check if this paper is already referenced (by PMID or title substring)
    const lowerContent = htmlContent.toLowerCase();
    if (paper.pmid && lowerContent.includes(paper.pmid)) {
      return null; // Already referenced
    }
    // Check by a significant title fragment (first 50 chars, lowered)
    const titleFragment = paper.title.toLowerCase().slice(0, 50);
    if (titleFragment.length > 20 && lowerContent.includes(titleFragment)) {
      return null; // Already referenced
    }

    // Strategy 1: Find an existing references/research section by heading text
    // Only insert into lists that live INSIDE a recognized references section.
    const refSectionPatterns = [
      // Match heading containing references-like text, then the LAST </ul> or </ol> within that section
      /(<h[2-4][^>]*>[^<]*(?:References|Further Reading|Latest Research|Recent Research|Recent Studies|Sources|Bibliography)[^<]*<\/h[2-4]>[\s\S]*?)(<\/[uo]l>)/i,
      // Match a section/div with class containing "reference" or "recent-research"
      /(<(?:section|div)[^>]*class="[^"]*(?:reference|recent-research)[^"]*"[^>]*>[\s\S]*?)(<\/[uo]l>)/i
    ];

    for (const pattern of refSectionPatterns) {
      const match = htmlContent.match(pattern);
      if (match) {
        // Insert before the closing </ul> or </ol> within the references section
        const insertPoint = match.index + match[0].length - match[2].length;
        return htmlContent.slice(0, insertPoint) + '\n' + refHtml + '\n      ' + htmlContent.slice(insertPoint);
      }
    }

    // Strategy 2: No references section exists — CREATE one.
    // Insert a new <section class="recent-research"> before the main content
    // area closes. Look for </div> before </main>, or before <script.
    // NEVER insert into arbitrary lists.
    const newSection =
      '\n    <section class="recent-research">\n' +
      '      <h2>Recent Research</h2>\n' +
      '      <p>Recent studies relevant to this topic:</p>\n' +
      '      <ul class="reference-list">\n' +
      refHtml + '\n' +
      '      </ul>\n' +
      '    </section>\n';

    // Try to insert before </main>
    const mainCloseIdx = htmlContent.lastIndexOf('</main>');
    if (mainCloseIdx > -1) {
      // Find the last </div> before </main> — that's typically the content wrapper close
      const beforeMain = htmlContent.slice(0, mainCloseIdx);
      const lastDivClose = beforeMain.lastIndexOf('</div>');
      if (lastDivClose > -1) {
        return htmlContent.slice(0, lastDivClose) + newSection + '\n' + htmlContent.slice(lastDivClose);
      }
      // Fallback: insert right before </main>
      return htmlContent.slice(0, mainCloseIdx) + newSection + '\n' + htmlContent.slice(mainCloseIdx);
    }

    // Try before first <script tag
    const scriptIdx = htmlContent.indexOf('<script');
    if (scriptIdx > -1) {
      const beforeScript = htmlContent.slice(0, scriptIdx);
      const lastDivClose = beforeScript.lastIndexOf('</div>');
      if (lastDivClose > -1) {
        return htmlContent.slice(0, lastDivClose) + newSection + '\n' + htmlContent.slice(lastDivClose);
      }
    }

    // Strategy 3: Can't find a safe insertion point — don't modify
    return null;
  }

  // ── Map intake items to projects ───────────────────────────
  // Tries to map a sensor intake item to a configured project ID.
  // Matching strategy (in order):
  //   1. GitHub source: match by repo name substring against project.githubRepo
  //   2. PubMed source: match by query name against project.id or keywords
  //   3. RSS/title: match by project.keywords array against title/tags
  //
  // Projects are configured in soma.config.js → projects:
  //   [{ id: 'my-site', path: '/path/to/site', githubRepo: 'user/repo', keywords: ['topic1'] }]

  _mapToProject(intakeItem) {
    const source = intakeItem.source || '';
    const data = intakeItem.data || {};
    const query = (data.query || '').toLowerCase();
    const title = (data.title || '').toLowerCase();
    const tags = (data.tags || []).map(t => t.toLowerCase());

    // Get configured projects
    const projects = Object.keys(this.projectPaths).map(id => {
      const proj = (_config.projects || []).find(p => p.id === id) || { id };
      return proj;
    });

    if (projects.length === 0) return null;

    // GitHub sensor: match by repo name
    if (source === 'github' || source.includes('github')) {
      const repo = (data.repo || data.repository || '').toLowerCase();
      for (const proj of projects) {
        const ghRepo = (proj.githubRepo || proj.id || '').toLowerCase();
        const repoName = ghRepo.includes('/') ? ghRepo.split('/')[1] : ghRepo;
        if (repo.includes(repoName) || (repoName && repoName.length > 3 && repo.includes(repoName))) {
          return proj.id;
        }
      }
    }

    // PubMed sensor: match by query name against project ID or configured keywords
    if (source === 'pubmed' || source.includes('pubmed')) {
      for (const proj of projects) {
        if (query === proj.id || query.includes(proj.id)) return proj.id;
        const keywords = (proj.keywords || []).map(k => k.toLowerCase());
        if (keywords.some(k => query.includes(k))) return proj.id;
      }
    }

    // Title/tag-based fallback: match configured project keywords against title and tags
    for (const proj of projects) {
      const keywords = (proj.keywords || []).map(k => k.toLowerCase());
      if (keywords.length === 0) continue;
      if (keywords.some(k => title.includes(k))) return proj.id;
      if (tags.some(t => keywords.some(k => t.includes(k)))) return proj.id;
    }

    return null;
  }

  // ── Extract keywords from an intake item ───────────────────

  _extractKeywords(item) {
    const keywords = new Set();
    const data = item.data || {};

    // Title words (skip common words)
    if (data.title) {
      const stopWords = new Set([
        'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
        'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
        'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
        'could', 'should', 'may', 'might', 'can', 'shall', 'not', 'no', 'nor',
        'it', 'its', 'this', 'that', 'these', 'those', 'which', 'what', 'who',
        'how', 'than', 'as', 'if', 'then', 'so', 'also', 'between', 'through',
        'during', 'before', 'after', 'above', 'below', 'up', 'down', 'out',
        'into', 'over', 'under', 'about', 'each', 'all', 'both', 'few', 'more',
        'most', 'other', 'some', 'such', 'only', 'own', 'same', 'very', 'just'
      ]);
      const words = data.title.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));
      for (const w of words) keywords.add(w);
    }

    // MeSH terms (highly structured medical vocabulary)
    if (Array.isArray(data.meshTerms)) {
      for (const term of data.meshTerms) {
        keywords.add(term.toLowerCase());
      }
    }

    // Article keywords
    if (Array.isArray(data.keywords)) {
      for (const kw of data.keywords) {
        keywords.add(kw.toLowerCase());
      }
    }

    return [...keywords];
  }

  // ── Map keywords to medical concept categories ─────────────

  _categorizeKeywords(keywords) {
    const categories = {
      'family-care': ['caregiver', 'family', 'quality of life', 'support', 'parent', 'sibling', 'daily life'],
      'treatment': ['gene therapy', 'hsct', 'transplant', 'treatment', 'therapy', 'drug', 'medication', 'intervention', 'clinical trial'],
      'monitoring-diagnosis': ['mri', 'imaging', 'neurological', 'diagnosis', 'screening', 'biomarker', 'enzyme', 'testing'],
      'genetics': ['gene', 'genetic', 'arylsulfatase', 'col11a1', 'mutation', 'variant', 'inheritance', 'chromosome'],
      'nutrition-supplements': ['diet', 'nutrition', 'supplement', 'vitamin', 'mineral', 'antioxidant', 'ferroptosis'],
      'pain-management': ['pain', 'neuropathic', 'central sensitization', 'analgesic', 'anti-inflammatory'],
      'spine': ['disc', 'spine', 'vertebral', 'scoliosis', 'endplate', 'cervical', 'lumbar'],
      'research': ['research', 'study', 'trial', 'evidence', 'mechanism', 'pathway', 'molecular'],
      'eye-ear': ['retinal', 'vitreous', 'hearing', 'cochlear', 'tectorial', 'audiology', 'ophthalmology']
    };

    const matched = new Map();
    for (const kw of keywords) {
      for (const [category, terms] of Object.entries(categories)) {
        if (terms.some(t => kw.includes(t) || t.includes(kw))) {
          if (!matched.has(category)) matched.set(category, []);
          matched.get(category).push(kw);
        }
      }
    }

    return matched;
  }

  // ── Check if a topic is already covered ────────────────────

  async _checkCoverage(project, keywords) {
    const projectPath = this.projectPaths[project];
    const pages = await this._parseNavPages(projectPath);

    if (pages.length === 0) {
      return { covered: false, coveringPages: [], gapKeywords: [...keywords] };
    }

    // First pass: check nav.js keyword data (fast, no file I/O)
    const coveringPages = [];
    const foundKeywords = new Set();

    for (const page of pages) {
      const pageKeywords = (page.keywords || '').toLowerCase();
      const pageTitle = (page.title || '').toLowerCase();
      const searchText = pageKeywords + ' ' + pageTitle;

      let matchCount = 0;
      for (const kw of keywords) {
        if (searchText.includes(kw)) {
          foundKeywords.add(kw);
          matchCount++;
        }
      }

      // Page matches if at least 2 keywords hit (or 1 for very specific terms)
      if (matchCount >= 2 || (matchCount >= 1 && keywords.length <= 3)) {
        coveringPages.push(page.file);
      }
    }

    const gapKeywords = keywords.filter(kw => !foundKeywords.has(kw));
    const coverageRatio = foundKeywords.size / Math.max(1, keywords.length);

    return {
      covered: coverageRatio >= 0.5, // >50% of keywords found = topic covered
      coveringPages: coveringPages.slice(0, 5),
      gapKeywords
    };
  }

  // ── Parse nav.js to get all page paths ─────────────────────

  async _parseNavPages(projectPath) {
    // Check cache
    const cached = this._navCache.get(projectPath);
    const cacheAge = this._navCacheAge.get(projectPath) || 0;
    if (cached && (Date.now() - cacheAge) < this._navCacheTTL) {
      return cached;
    }

    const navFile = path.join(projectPath, 'nav.js');
    const pages = [];

    try {
      const content = await fs.readFile(navFile, 'utf8');

      // Extract the SITE array structure using regex
      // Each page entry has: file, title, and k (keywords)
      const pagePattern = /\{\s*file:\s*'([^']+)'\s*,\s*title:\s*'([^']+)'\s*,\s*k:\s*'([^']*)'/g;
      let match;

      while ((match = pagePattern.exec(content)) !== null) {
        pages.push({
          file: match[1],
          title: match[2],
          keywords: match[3]
        });
      }
    } catch (err) {
      console.error(`[ActionPipeline] Failed to parse nav.js at ${navFile}: ${err.message}`);
    }

    // Cache results
    this._navCache.set(projectPath, pages);
    this._navCacheAge.set(projectPath, Date.now());

    return pages;
  }

  // ── Format authors for reference display ───────────────────

  _formatAuthors(authors) {
    if (!authors || authors.length === 0) return '';

    const names = authors.map(a => {
      if (typeof a === 'string') return a;
      return a.name || a.lastName || `${a.last || ''}${a.first ? ' ' + a.first[0] : ''}`;
    });

    if (names.length === 0) return '';
    if (names.length === 1) return `<strong>${this._escapeHtml(names[0])}</strong>. `;
    if (names.length === 2) return `<strong>${this._escapeHtml(names[0])} & ${this._escapeHtml(names[1])}</strong>. `;
    return `<strong>${this._escapeHtml(names[0])} et al.</strong> `;
  }

  // ── Git operations ─────────────────────────────────────────

  async _gitCommitAndPush(projectPath, files, message) {
    const opts = {
      cwd: projectPath,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    };

    // Stage files
    for (const file of files) {
      execSync(`git add "${file}"`, opts);
    }

    // Check if there are actually staged changes
    const status = execSync('git status --porcelain', opts).trim();
    if (!status) {
      return { hash: null, pushed: false };
    }

    // Commit
    const escapedMsg = message.replace(/"/g, '\\"');
    execSync(`git commit -m "${escapedMsg}"`, opts);

    // Get the commit hash
    const hash = execSync('git rev-parse --short HEAD', opts).trim();

    // Get current branch
    const branch = execSync('git branch --show-current', opts).trim();

    // Push
    let pushed = false;
    try {
      execSync(`git push origin ${branch}`, opts);
      pushed = true;
    } catch (pushErr) {
      console.error(`[ActionPipeline] Push failed: ${pushErr.message}`);
      // Don't throw — local commit is still valid
    }

    return { hash, pushed };
  }

  // ── Summary for dashboard ──────────────────────────────────

  summary() {
    const statusCounts = {
      total: this.queue.length,
      queued: 0,
      assessed: 0,
      executing: 0,
      completed: 0,
      failed: 0
    };

    for (const action of this.queue) {
      if (statusCounts[action.status] !== undefined) {
        statusCounts[action.status]++;
      }
    }

    return {
      ...statusCounts,
      recentActions: this.queue
        .filter(a => a.status === 'completed')
        .slice(-5)
        .map(a => ({
          id: a.id,
          project: a.project,
          type: a.type,
          title: a.source?.title,
          filesChanged: a.execution?.filesChanged?.length || 0,
          pushed: a.execution?.pushed || false,
          completedAt: a.updatedAt
        }))
    };
  }

  selfReport() {
    const s = this.summary();
    return {
      ...s,
      queueFile: this.queueFile,
      projects: Object.keys(this.projectPaths)
    };
  }

  // ── Maintenance ────────────────────────────────────────────

  async prune(maxAge = 7 * 24 * 60 * 60 * 1000) { // 7 days
    const cutoff = Date.now() - maxAge;
    const before = this.queue.length;

    this.queue = this.queue.filter(a => {
      // Keep non-terminal items
      if (a.status !== 'completed' && a.status !== 'failed') return true;
      // Keep recent completions/failures
      return (a.updatedAt || a.createdAt) > cutoff;
    });

    if (this.queue.length < before) {
      await this.save();
      return before - this.queue.length;
    }
    return 0;
  }

  // ── Utility helpers ────────────────────────────────────────

  _escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _truncate(str, maxLen) {
    if (!str || str.length <= maxLen) return str;
    return str.slice(0, maxLen - 3) + '...';
  }
}

module.exports = ActionPipeline;
