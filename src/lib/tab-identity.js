// Tab IDs are not stable across a discard.
//
// Chrome may swap a discarded tab for a replacement and reassign its ID,
// announcing it via chrome.tabs.onReplaced(addedTabId, removedTabId). Any code
// that holds a tab ID across a discard — the snapshot/undo system, the
// diagnostics harness — is wrong without this.
//
// Discovered the hard way: the first run of the discard-preservation test
// reported "discard lost" when what had actually happened was that the IDs it
// was holding had ceased to exist.

/** oldId -> newId. Chains are possible if a tab is replaced repeatedly. */
const remap = new Map();

let listening = false;

/** Start tracking replacements. Idempotent; safe to call from any context. */
export function startTracking() {
  if (listening) return;
  if (!chrome.tabs?.onReplaced) return;
  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    remap.set(removedTabId, addedTabId);
  });
  listening = true;
}

/** Follow the replacement chain to the tab's current ID. */
export function resolveTabId(tabId) {
  let current = tabId;
  const seen = new Set();
  while (remap.has(current) && !seen.has(current)) {
    seen.add(current);
    current = remap.get(current);
  }
  return current;
}

export function wasReplaced(tabId) {
  return resolveTabId(tabId) !== tabId;
}

export function clearTracking() {
  remap.clear();
}

/**
 * Discard a tab and return its *current* ID afterwards.
 *
 * Prefers the Tab object chrome.tabs.discard() resolves with — that is
 * authoritative for post-discard identity. Falls back to the onReplaced map,
 * then to the original ID.
 */
export async function discardAndTrack(tabId) {
  startTracking();
  const before = tabId;
  let returned = null;

  try {
    returned = await chrome.tabs.discard(tabId);
  } catch (err) {
    return { ok: false, before, after: null, changed: false, error: String(err?.message ?? err) };
  }

  // Give onReplaced a turn of the event loop to land.
  await new Promise((r) => setTimeout(r, 0));

  const after = returned?.id ?? resolveTabId(before);
  return { ok: true, before, after, changed: after !== before, error: null };
}

/**
 * Find a live tab matching a snapshot entry whose ID no longer resolves.
 * Matches on URL, preferring one that hasn't already been claimed.
 * This is the durable fallback — it survives browser restarts, where the
 * in-memory remap does not.
 */
export function matchByUrl(entry, liveTabs, claimed) {
  if (!entry.url) return null;
  const candidates = liveTabs.filter((t) => t.url === entry.url && !claimed.has(t.id));
  if (candidates.length === 0) return null;
  // Prefer one already in the right window, then closest to the right index.
  candidates.sort((a, b) => {
    const aw = a.windowId === entry.windowId ? 0 : 1;
    const bw = b.windowId === entry.windowId ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return Math.abs(a.index - entry.index) - Math.abs(b.index - entry.index);
  });
  return candidates[0];
}
