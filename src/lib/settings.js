// Settings live in chrome.storage.local (small, synchronous-ish, survives
// reinstall of the DB). The archive itself lives in IndexedDB — see db.js.

const KEY = 'settings';

// Excluded domains never get archived, and — once the AI layer exists — their
// URLs and titles never leave the machine. Built now rather than later on
// purpose: see decisions/002, "Mitigation required before the first API call".
export const DEFAULT_SETTINGS = {
  excludedDomains: [
    'mail.google.com',
    'accounts.google.com',
    'web.whatsapp.com',
    'localhost',
    '127.0.0.1'
  ],
  // Tabs untouched for longer than this are "stale" and eligible for archiving.
  staleAfterDays: 14,
  // Never discard a tab that is playing audio.
  protectAudible: true,
  // Never discard or archive pinned tabs.
  protectPinned: true
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[KEY] ?? {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/** Hostname of a URL, or '' for anything unparseable (chrome://, about:, ...). */
export function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** True if this URL matches an excluded domain (exact host or subdomain). */
export function isExcluded(url, excludedDomains) {
  const host = hostnameOf(url);
  if (!host) return false;
  return excludedDomains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`)
  );
}
