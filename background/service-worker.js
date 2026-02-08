/**
 * Background Service Worker for Duplicate Tab Closer
 * Handles badge updates only - analysis done in popup
 */

// Update badge with duplicate count
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});
    const duplicateCount = countDuplicates(tabs);

    if (duplicateCount > 0) {
      chrome.action.setBadgeText({ text: duplicateCount.toString() });
      chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) {
    console.error('Error updating badge:', e);
  }
}

// Simple duplicate counter for badge (exact duplicates only)
function countDuplicates(tabs) {
  const urlCounts = new Map();

  for (const tab of tabs) {
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      continue;
    }

    // Simple normalization for counting
    const normalized = normalizeUrlSimple(tab.url);
    urlCounts.set(normalized, (urlCounts.get(normalized) || 0) + 1);
  }

  let duplicates = 0;
  for (const count of urlCounts.values()) {
    if (count > 1) {
      duplicates += count - 1;
    }
  }

  return duplicates;
}

function normalizeUrlSimple(urlString) {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const params = [...url.searchParams.entries()].sort().map(([k,v]) => `${k}=${v}`).join('&');
    return `${url.protocol}//${hostname}${url.port ? ':' + url.port : ''}${pathname}${params ? '?' + params : ''}`;
  } catch (e) {
    return urlString;
  }
}

// Listen for tab events to update badge
chrome.tabs.onCreated.addListener(updateBadge);
chrome.tabs.onRemoved.addListener(updateBadge);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.title) {
    updateBadge();
  }
});

// Initial badge update
updateBadge();
