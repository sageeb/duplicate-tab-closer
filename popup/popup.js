/**
 * Popup UI Logic for Duplicate Tab Closer
 */

// ============ Fuzzy Matcher (inline) ============

// Google Workspace URL patterns for document detection
const GOOGLE_WORKSPACE_PATTERNS = [
  { pattern: /^docs\.google\.com\/document\/d\/([^\/]+)/, type: 'doc' },
  { pattern: /^docs\.google\.com\/spreadsheets\/d\/([^\/]+)/, type: 'sheet' },
  { pattern: /^docs\.google\.com\/presentation\/d\/([^\/]+)/, type: 'slides' },
];

function getGoogleDocId(hostname, pathname) {
  const combined = hostname + pathname;
  for (const { pattern, type } of GOOGLE_WORKSPACE_PATTERNS) {
    const match = combined.match(pattern);
    if (match) {
      return { docId: match[1], type };
    }
  }
  return null;
}

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'msclkid', 'dclid', 'ref', 'source', 'mc_cid', 'mc_eid',
  '_ga', '_gl', 'yclid', 'wickedid', 'twclid', 'igshid', 'zanpid'
]);

function parseUrl(urlString) {
  try {
    const url = new URL(urlString);
    return {
      protocol: url.protocol,
      hostname: url.hostname.toLowerCase(),
      port: url.port,
      pathname: url.pathname.replace(/\/+$/, '') || '/',
      search: url.search,
      hash: url.hash,
      params: Object.fromEntries(url.searchParams.entries()),
      original: urlString
    };
  } catch (e) {
    return null;
  }
}

function normalizeUrl(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return urlString;
  const hostname = parsed.hostname.replace(/^www\./, '');
  const sortedParams = Object.keys(parsed.params).sort().map(k => `${k}=${parsed.params[k]}`).join('&');
  const query = sortedParams ? `?${sortedParams}` : '';
  return `${parsed.protocol}//${hostname}${parsed.port ? ':' + parsed.port : ''}${parsed.pathname}${query}`;
}

function levenshteinDistance(str1, str2) {
  const m = str1.length, n = str2.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function stringSimilarity(str1, str2) {
  if (str1 === str2) return 100;
  if (!str1 || !str2) return 0;
  const maxLen = Math.max(str1.length, str2.length);
  return Math.round((1 - levenshteinDistance(str1, str2) / maxLen) * 100);
}

function getNonTrackingParams(params) {
  const filtered = {};
  for (const [key, value] of Object.entries(params)) {
    if (!TRACKING_PARAMS.has(key.toLowerCase())) filtered[key] = value;
  }
  return filtered;
}

function differsByTrackingOnly(params1, params2) {
  return JSON.stringify(getNonTrackingParams(params1)) === JSON.stringify(getNonTrackingParams(params2));
}

function findSimilarity(tab1, tab2, threshold = 80) {
  const url1 = parseUrl(tab1.url);
  const url2 = parseUrl(tab2.url);
  if (!url1 || !url2) return { similar: false, score: 0, reason: null };

  const host1 = url1.hostname.replace(/^www\./, '');
  const host2 = url2.hostname.replace(/^www\./, '');

  // Note: Google Workspace docs are handled separately in analyzeTabs via grouping

  // Subdomain variation
  if (url1.hostname !== url2.hostname && host1 === host2 && url1.pathname === url2.pathname) {
    if (JSON.stringify(url1.params) === JSON.stringify(url2.params)) {
      return { similar: true, score: 95, reason: 'Same page on different subdomain' };
    }
  }

  if (host1 !== host2) return { similar: false, score: 0, reason: null };

  // Same path, different hash
  if (url1.pathname === url2.pathname && JSON.stringify(url1.params) === JSON.stringify(url2.params) && url1.hash !== url2.hash) {
    return { similar: true, score: 90, reason: 'Same page, different section' };
  }

  // Same path, different params
  if (url1.pathname === url2.pathname) {
    if (JSON.stringify(url1.params) !== JSON.stringify(url2.params)) {
      if (differsByTrackingOnly(url1.params, url2.params)) {
        return { similar: true, score: 95, reason: 'Same page with tracking parameters' };
      }
      return { similar: true, score: 85, reason: 'Same page, different parameters' };
    }
  }

  // Similar path (Levenshtein)
  const pathSimilarity = stringSimilarity(url1.pathname, url2.pathname);
  if (pathSimilarity >= threshold && pathSimilarity < 100) {
    return { similar: true, score: pathSimilarity, reason: `Similar page paths (${pathSimilarity}% match)` };
  }

  // Weighted score
  const domainScore = host1 === host2 ? 100 : 0;
  const pathScore = stringSimilarity(url1.pathname, url2.pathname);
  const titleScore = tab1.title && tab2.title ? stringSimilarity(tab1.title, tab2.title) : 0;
  const weightedScore = Math.round(domainScore * 0.4 + pathScore * 0.4 + titleScore * 0.2);

  if (weightedScore >= threshold) {
    return { similar: true, score: weightedScore, reason: `${weightedScore}% overall similarity` };
  }
  return { similar: false, score: weightedScore, reason: null };
}

function analyzeTabs(tabs, threshold = 80) {
  const exactDuplicates = new Map();
  const similarPairs = [];
  const processed = new Set();

  // Filter valid tabs
  const validTabs = tabs.filter(tab =>
    tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')
  );

  // Find exact duplicates by normalized URL
  for (const tab of validTabs) {
    const normalized = normalizeUrl(tab.url);
    if (!exactDuplicates.has(normalized)) exactDuplicates.set(normalized, []);
    exactDuplicates.get(normalized).push(tab);
  }

  // Also group Google Docs by document ID (treat same doc as exact duplicate)
  const googleDocGroups = new Map();
  for (const tab of validTabs) {
    if (tab.url && tab.url.includes('docs.google.com')) {
      const parsed = parseUrl(tab.url);
      if (parsed) {
        const googleDoc = getGoogleDocId(parsed.hostname, parsed.pathname);
        if (googleDoc) {
          const key = 'gdoc:' + googleDoc.type + ':' + googleDoc.docId;
          if (!googleDocGroups.has(key)) googleDocGroups.set(key, []);
          googleDocGroups.get(key).push(tab);
        }
      }
    }
  }

  // Build duplicate groups from both URL matches and Google Doc matches
  const duplicateGroups = [];
  const tabsInDuplicateGroups = new Set();

  // First, add Google Doc groups (these take priority)
  for (const [key, tabGroup] of googleDocGroups) {
    if (tabGroup.length > 1) {
      duplicateGroups.push({
        normalizedUrl: key,
        tabs: tabGroup,
        count: tabGroup.length
      });
      tabGroup.forEach(t => tabsInDuplicateGroups.add(t.id));
    }
  }

  // Then add URL-based duplicates (only if not already in a Google Doc group)
  for (const [url, tabGroup] of exactDuplicates) {
    const filteredGroup = tabGroup.filter(t => !tabsInDuplicateGroups.has(t.id));
    if (filteredGroup.length > 1) {
      duplicateGroups.push({
        normalizedUrl: url,
        tabs: filteredGroup,
        count: filteredGroup.length
      });
      filteredGroup.forEach(t => tabsInDuplicateGroups.add(t.id));
    }
  }

  // Find similar tabs (only among tabs not in any duplicate group)
  const nonDuplicateTabs = validTabs.filter(tab => !tabsInDuplicateGroups.has(tab.id));

  // For non-Google tabs, use the regular comparison (limited to 100)
  const nonGoogleTabs = nonDuplicateTabs.filter(t => !t.url || !t.url.includes('docs.google.com')).slice(0, 100);

  for (let i = 0; i < nonGoogleTabs.length; i++) {
    for (let j = i + 1; j < nonGoogleTabs.length; j++) {
      const tab1 = nonGoogleTabs[i];
      const tab2 = nonGoogleTabs[j];

      const pairKey = `${tab1.id}-${tab2.id}`;
      if (processed.has(pairKey)) continue;
      processed.add(pairKey);

      const similarity = findSimilarity(tab1, tab2, threshold);
      if (similarity.similar) {
        similarPairs.push({ tab1, tab2, score: similarity.score, reason: similarity.reason });
      }
    }
  }

  similarPairs.sort((a, b) => b.score - a.score);

  return {
    exactDuplicates: duplicateGroups,
    similarTabs: similarPairs.slice(0, 20),
    totalDuplicates: duplicateGroups.reduce((sum, g) => sum + g.count - 1, 0),
    totalSimilar: Math.min(similarPairs.length, 20)
  };
}

// ============ DOM Elements ============

const loading = document.getElementById('loading');
const content = document.getElementById('content');
const exactSection = document.getElementById('exact-section');
const exactCount = document.getElementById('exact-count');
const exactList = document.getElementById('exact-list');
const closeAllBtn = document.getElementById('close-all-duplicates');
const similarSection = document.getElementById('similar-section');
const similarCount = document.getElementById('similar-count');
const similarList = document.getElementById('similar-list');
const noDuplicates = document.getElementById('no-duplicates');
const settingsToggle = document.getElementById('settings-toggle');
const settingsPanel = document.getElementById('settings-panel');
const thresholdSlider = document.getElementById('threshold');
const thresholdValue = document.getElementById('threshold-value');
const rescanBtn = document.getElementById('rescan');

// State
let currentAnalysis = null;
let threshold = 80;

async function init() {
  try {
    if (chrome.storage && chrome.storage.local) {
      const stored = await chrome.storage.local.get('threshold');
      if (stored.threshold) {
        threshold = stored.threshold;
        thresholdSlider.value = threshold;
        thresholdValue.textContent = `${threshold}%`;
      }
    }
  } catch (e) {
    console.warn('Could not load settings:', e);
  }
  setupEventListeners();
  await scanTabs();
}

function setupEventListeners() {
  closeAllBtn.addEventListener('click', closeAllDuplicates);
  settingsToggle.addEventListener('click', () => settingsPanel.classList.toggle('hidden'));
  thresholdSlider.addEventListener('input', (e) => {
    threshold = parseInt(e.target.value);
    thresholdValue.textContent = `${threshold}%`;
  });
  thresholdSlider.addEventListener('change', async (e) => {
    threshold = parseInt(e.target.value);
    try {
      if (chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ threshold });
      }
    } catch (err) {
      console.warn('Could not save settings:', err);
    }
    await scanTabs();
  });
  rescanBtn.addEventListener('click', scanTabs);
}

async function scanTabs() {
  loading.classList.remove('hidden');
  content.classList.add('hidden');

  try {
    const tabs = await chrome.tabs.query({});
    currentAnalysis = analyzeTabs(tabs, threshold);
    renderResults();
  } catch (e) {
    console.error('Error scanning tabs:', e);
  }

  loading.classList.add('hidden');
  content.classList.remove('hidden');
}

function renderResults() {
  if (!currentAnalysis) return;
  const { exactDuplicates, similarTabs, totalDuplicates, totalSimilar } = currentAnalysis;

  if (totalDuplicates === 0 && totalSimilar === 0) {
    exactSection.classList.add('hidden');
    similarSection.classList.add('hidden');
    noDuplicates.classList.remove('hidden');
    return;
  }

  noDuplicates.classList.add('hidden');
  renderExactDuplicates(exactDuplicates, totalDuplicates);
  renderSimilarTabs(similarTabs, totalSimilar);
}

function renderExactDuplicates(groups, total) {
  exactList.innerHTML = '';

  if (groups.length === 0) {
    exactSection.classList.add('hidden');
    return;
  }

  exactSection.classList.remove('hidden');
  exactCount.textContent = `${total} tab${total !== 1 ? 's' : ''}`;
  exactCount.classList.toggle('zero', total === 0);

  for (const group of groups) {
    const groupEl = document.createElement('div');
    groupEl.className = 'tab-group';
    const displayUrl = getDisplayUrl(group.tabs[0].url);

    groupEl.innerHTML = `
      <div class="tab-group-header">
        <span class="tab-group-title" title="${escapeHtml(group.tabs[0].url)}">${escapeHtml(displayUrl)}</span>
        <span class="tab-group-count">${group.count} tabs</span>
      </div>
    `;

    for (let i = 0; i < group.tabs.length; i++) {
      const tab = group.tabs[i];
      const tabEl = createTabElement(tab, i === 0 ? 'Keep' : null);
      groupEl.appendChild(tabEl);
    }

    exactList.appendChild(groupEl);
  }

  closeAllBtn.classList.remove('hidden');
}

function renderSimilarTabs(pairs, total) {
  similarList.innerHTML = '';

  if (pairs.length === 0) {
    similarSection.classList.add('hidden');
    return;
  }

  similarSection.classList.remove('hidden');
  similarCount.textContent = `${total} pair${total !== 1 ? 's' : ''}`;
  similarCount.classList.toggle('zero', total === 0);

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const pairEl = document.createElement('div');
    pairEl.className = 'similar-pair';
    pairEl.dataset.index = i;

    pairEl.innerHTML = `
      <div class="similar-reason"><span>Reason: ${escapeHtml(pair.reason)}</span></div>
      <div class="similar-tabs">
        ${createSimilarTabHtml(pair.tab1, 'A')}
        ${createSimilarTabHtml(pair.tab2, 'B')}
      </div>
      <div class="similar-actions">
        <button class="btn btn-success" data-action="keep" data-keep="1" data-close="2">Keep A</button>
        <button class="btn btn-success" data-action="keep" data-keep="2" data-close="1">Keep B</button>
        <button class="btn btn-skip" data-action="skip">Skip</button>
      </div>
    `;

    pairEl.querySelectorAll('[data-action="keep"]').forEach(btn => {
      btn.addEventListener('click', () => handleSimilarAction(pair, btn.dataset.close === '1' ? pair.tab1 : pair.tab2, pairEl));
    });
    pairEl.querySelector('[data-action="skip"]').addEventListener('click', () => {
      pairEl.remove();
      updateSimilarCount();
    });
    pairEl.querySelectorAll('.similar-tab').forEach((el, idx) => {
      el.addEventListener('click', () => focusTab(idx === 0 ? pair.tab1 : pair.tab2));
    });
    pairEl.querySelectorAll('.tab-favicon').forEach(img => {
      img.addEventListener('error', handleFaviconError);
    });

    similarList.appendChild(pairEl);
  }
}

const DEFAULT_FAVICON = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect fill="%23ddd" width="16" height="16" rx="2"/></svg>';

function handleFaviconError(e) {
  e.target.src = DEFAULT_FAVICON;
}

function createSimilarTabHtml(tab, label) {
  const favicon = tab.favIconUrl || DEFAULT_FAVICON;
  return `
    <div class="similar-tab" data-tab-id="${tab.id}">
      <img class="tab-favicon" src="${escapeHtml(favicon)}" alt="">
      <span class="tab-title" title="${escapeHtml(tab.url)}">[${label}] ${escapeHtml(tab.title || 'Untitled')}</span>
    </div>
  `;
}

function createTabElement(tab, badge = null) {
  const el = document.createElement('div');
  el.className = 'tab-item';
  el.dataset.tabId = tab.id;
  const favicon = tab.favIconUrl || DEFAULT_FAVICON;

  el.innerHTML = `
    <img class="tab-favicon" src="${escapeHtml(favicon)}" alt="">
    <span class="tab-title" title="${escapeHtml(tab.url)}">${escapeHtml(tab.title || 'Untitled')}</span>
    ${badge ? `<span class="tab-badge">${badge}</span>` : ''}
  `;
  el.querySelector('.tab-favicon').addEventListener('error', handleFaviconError);
  el.addEventListener('click', () => focusTab(tab));
  return el;
}

async function focusTab(tab) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (e) {
    console.error('Error focusing tab:', e);
  }
}

async function closeAllDuplicates() {
  if (!currentAnalysis) return;
  const tabsToClose = [];
  for (const group of currentAnalysis.exactDuplicates) {
    for (let i = 1; i < group.tabs.length; i++) {
      tabsToClose.push(group.tabs[i].id);
    }
  }
  if (tabsToClose.length === 0) return;

  try {
    await chrome.tabs.remove(tabsToClose);
  } catch (e) {
    // Some tabs may have been closed already - that's OK
    console.warn('Some tabs may have been closed already:', e.message);
  }
  await scanTabs();
}

async function handleSimilarAction(pair, tabToClose, pairEl) {
  try {
    await chrome.tabs.remove([tabToClose.id]);
    pairEl.remove();
    updateSimilarCount();
  } catch (e) {
    // Tab may have been closed already - just remove from UI and rescan
    console.warn('Tab already closed:', e.message);
    pairEl.remove();
    updateSimilarCount();
  }
}

function updateSimilarCount() {
  const remaining = similarList.querySelectorAll('.similar-pair').length;
  similarCount.textContent = `${remaining} pair${remaining !== 1 ? 's' : ''}`;
  if (remaining === 0) {
    similarSection.classList.add('hidden');
    checkEmpty();
  }
}

function checkEmpty() {
  if (exactSection.classList.contains('hidden') && similarSection.classList.contains('hidden')) {
    noDuplicates.classList.remove('hidden');
  }
}

function getDisplayUrl(url) {
  try {
    const parsed = new URL(url);
    let display = parsed.hostname.replace(/^www\./, '');
    if (parsed.pathname !== '/') display += parsed.pathname;
    return display.length > 50 ? display.substring(0, 47) + '...' : display;
  } catch (e) {
    return url;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

document.addEventListener('DOMContentLoaded', init);
