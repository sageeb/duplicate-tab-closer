/**
 * Fuzzy URL Matcher - URL similarity algorithms for duplicate tab detection
 */

// Google Workspace URL patterns for document detection
const GOOGLE_WORKSPACE_PATTERNS = [
  { pattern: /^docs\.google\.com\/document\/d\/([^\/]+)/, type: 'doc' },
  { pattern: /^docs\.google\.com\/spreadsheets\/d\/([^\/]+)/, type: 'sheet' },
  { pattern: /^docs\.google\.com\/presentation\/d\/([^\/]+)/, type: 'slides' },
];

/**
 * Extract Google Workspace document ID from URL
 */
function getGoogleDocId(hostname, pathname) {
  for (const { pattern, type } of GOOGLE_WORKSPACE_PATTERNS) {
    const match = (hostname + pathname).match(pattern);
    if (match) {
      return { docId: match[1], type };
    }
  }
  return null;
}

// Common tracking parameters to ignore
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'msclkid', 'dclid',
  'ref', 'source', 'mc_cid', 'mc_eid',
  '_ga', '_gl', 'yclid', 'wickedid',
  'twclid', 'igshid', 'zanpid'
]);

/**
 * Parse a URL into components for comparison
 */
export function parseUrl(urlString) {
  try {
    const url = new URL(urlString);
    return {
      protocol: url.protocol,
      hostname: url.hostname.toLowerCase(),
      port: url.port,
      pathname: url.pathname.replace(/\/+$/, '') || '/', // Remove trailing slashes
      search: url.search,
      hash: url.hash,
      params: Object.fromEntries(url.searchParams.entries()),
      original: urlString
    };
  } catch (e) {
    return null;
  }
}

/**
 * Normalize a URL for exact matching
 */
export function normalizeUrl(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return urlString;

  // Normalize hostname (remove www.)
  const hostname = parsed.hostname.replace(/^www\./, '');

  // Sort query params for consistent comparison
  const sortedParams = Object.keys(parsed.params)
    .sort()
    .map(k => `${k}=${parsed.params[k]}`)
    .join('&');

  const query = sortedParams ? `?${sortedParams}` : '';

  return `${parsed.protocol}//${hostname}${parsed.port ? ':' + parsed.port : ''}${parsed.pathname}${query}`;
}

/**
 * Normalize URL without query params (for base comparison)
 */
export function normalizeUrlBase(urlString) {
  const parsed = parseUrl(urlString);
  if (!parsed) return urlString;

  const hostname = parsed.hostname.replace(/^www\./, '');
  return `${parsed.protocol}//${hostname}${parsed.port ? ':' + parsed.port : ''}${parsed.pathname}`;
}

/**
 * Check if two URLs are exact duplicates after normalization
 */
export function isExactDuplicate(url1, url2) {
  return normalizeUrl(url1) === normalizeUrl(url2);
}

/**
 * Calculate Levenshtein distance between two strings
 */
export function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;

  if (m === 0) return n;
  if (n === 0) return m;

  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return dp[m][n];
}

/**
 * Calculate similarity percentage between two strings
 */
export function stringSimilarity(str1, str2) {
  if (str1 === str2) return 100;
  if (!str1 || !str2) return 0;

  const maxLen = Math.max(str1.length, str2.length);
  const distance = levenshteinDistance(str1, str2);
  return Math.round((1 - distance / maxLen) * 100);
}

/**
 * Get non-tracking query params
 */
function getNonTrackingParams(params) {
  const filtered = {};
  for (const [key, value] of Object.entries(params)) {
    if (!TRACKING_PARAMS.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Check if params differ only by tracking parameters
 */
function differsByTrackingOnly(params1, params2) {
  const clean1 = getNonTrackingParams(params1);
  const clean2 = getNonTrackingParams(params2);
  return JSON.stringify(clean1) === JSON.stringify(clean2);
}

/**
 * Find similarity between two tabs
 * Returns { similar: boolean, score: number, reason: string }
 */
export function findSimilarity(tab1, tab2, threshold = 80) {
  const url1 = parseUrl(tab1.url);
  const url2 = parseUrl(tab2.url);

  if (!url1 || !url2) {
    return { similar: false, score: 0, reason: null };
  }

  // Normalize hostnames (remove www.)
  const host1 = url1.hostname.replace(/^www\./, '');
  const host2 = url2.hostname.replace(/^www\./, '');

  // Note: Google Workspace docs are handled separately in analyzeTabs via grouping

  // Check for subdomain variation (www vs non-www)
  if (url1.hostname !== url2.hostname && host1 === host2 && url1.pathname === url2.pathname) {
    const paramsMatch = JSON.stringify(url1.params) === JSON.stringify(url2.params);
    if (paramsMatch) {
      return { similar: true, score: 95, reason: 'Same page on different subdomain' };
    }
  }

  // Must be same base domain for other checks
  if (host1 !== host2) {
    return { similar: false, score: 0, reason: null };
  }

  // Same path, different hash/fragment
  if (url1.pathname === url2.pathname &&
      JSON.stringify(url1.params) === JSON.stringify(url2.params) &&
      url1.hash !== url2.hash) {
    return { similar: true, score: 90, reason: 'Same page, different section' };
  }

  // Same path, different query params
  if (url1.pathname === url2.pathname) {
    const params1Str = JSON.stringify(url1.params);
    const params2Str = JSON.stringify(url2.params);

    if (params1Str !== params2Str) {
      // Check if only tracking params differ
      if (differsByTrackingOnly(url1.params, url2.params)) {
        return { similar: true, score: 95, reason: 'Same page with tracking parameters' };
      }
      return { similar: true, score: 85, reason: 'Same page, different parameters' };
    }
  }

  // Similar path (Levenshtein)
  const pathSimilarity = stringSimilarity(url1.pathname, url2.pathname);
  if (pathSimilarity >= threshold && pathSimilarity < 100) {
    return {
      similar: true,
      score: pathSimilarity,
      reason: `Similar page paths (${pathSimilarity}% match)`
    };
  }

  // Calculate weighted similarity score
  const domainScore = host1 === host2 ? 100 : 0;
  const pathScore = stringSimilarity(url1.pathname, url2.pathname);
  const titleScore = tab1.title && tab2.title ? stringSimilarity(tab1.title, tab2.title) : 0;

  const weightedScore = Math.round(
    domainScore * 0.4 +
    pathScore * 0.4 +
    titleScore * 0.2
  );

  if (weightedScore >= threshold) {
    return {
      similar: true,
      score: weightedScore,
      reason: `${weightedScore}% overall similarity`
    };
  }

  return { similar: false, score: weightedScore, reason: null };
}

/**
 * Analyze all tabs and find duplicates/similar tabs
 */
export function analyzeTabs(tabs, threshold = 80) {
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
    if (!exactDuplicates.has(normalized)) {
      exactDuplicates.set(normalized, []);
    }
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
        similarPairs.push({
          tab1,
          tab2,
          score: similarity.score,
          reason: similarity.reason
        });
      }
    }
  }

  // Sort similar pairs by score descending
  similarPairs.sort((a, b) => b.score - a.score);

  return {
    exactDuplicates: duplicateGroups,
    similarTabs: similarPairs,
    totalDuplicates: duplicateGroups.reduce((sum, g) => sum + g.count - 1, 0),
    totalSimilar: similarPairs.length
  };
}
