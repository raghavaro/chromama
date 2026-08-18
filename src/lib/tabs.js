// Core tab operations. The two jobs this project separates (see decisions/001):
//
//   reclaim RAM       -> discard()  : tab stays in the strip, reloads on click
//   reclaim attention -> archive()  : tab closes, state goes to IndexedDB
//
// Everything here is deliberately non-AI. Heuristics first.

import { getSettings, isExcluded, hostnameOf } from './settings.js';
import { discardAndTrack, startTracking } from './tab-identity.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getAllTabs() {
  return chrome.tabs.query({});
}

export async function getAllWindows() {
  return chrome.windows.getAll({ populate: true });
}

export async function getAllGroups() {
  try {
    return await chrome.tabGroups.query({});
  } catch {
    return [];
  }
}

/** ms since the tab was last activated, or null when Chrome doesn't report it. */
export function idleMs(tab, now = Date.now()) {
  if (typeof tab.lastAccessed !== 'number') return null;
  return Math.max(0, now - tab.lastAccessed);
}

/**
 * Can this tab be discarded right now?
 * Returns { ok: true } or { ok: false, reason: string }.
 */
export function discardEligibility(tab, settings) {
  if (tab.discarded) return { ok: false, reason: 'already discarded' };
  if (tab.active) return { ok: false, reason: 'active in its window' };
  if (settings.protectPinned && tab.pinned) return { ok: false, reason: 'pinned' };
  if (settings.protectAudible && tab.audible) return { ok: false, reason: 'playing audio' };
  return { ok: true };
}

/**
 * Discard every eligible tab. Non-destructive: discarded tabs keep their place,
 * title and favicon, and reload when clicked.
 * Returns { attempted, discarded, skipped, errors }.
 */
export async function discardEligibleTabs({ tabIds = null } = {}) {
  startTracking(); // discarding can reassign tab IDs — see tab-identity.js
  const settings = await getSettings();
  const all = await getAllTabs();
  const pool = tabIds ? all.filter((t) => tabIds.includes(t.id)) : all;

  const targets = [];
  const skipped = [];

  for (const tab of pool) {
    const verdict = discardEligibility(tab, settings);
    if (verdict.ok) targets.push(tab);
    else skipped.push({ id: tab.id, title: tab.title, reason: verdict.reason });
  }

  const errors = [];
  let discarded = 0;
  let reassignedIds = 0;

  for (const tab of targets) {
    const result = await discardAndTrack(tab.id);
    if (result.ok) {
      discarded += 1;
      if (result.changed) reassignedIds += 1;
    } else {
      errors.push({ id: tab.id, title: tab.title, message: result.error });
    }
  }

  return { attempted: targets.length, discarded, reassignedIds, skipped, errors };
}

/**
 * Tabs that look like archive candidates: stale, not excluded, not protected.
 * Ranked oldest-first. This is the heuristic pass — no model involved.
 */
export async function staleTabs() {
  const settings = await getSettings();
  const all = await getAllTabs();
  const now = Date.now();
  const threshold = settings.staleAfterDays * DAY_MS;

  return all
    .filter((tab) => {
      if (settings.protectPinned && tab.pinned) return false;
      if (tab.active) return false;
      if (isExcluded(tab.url ?? '', settings.excludedDomains)) return false;
      const idle = idleMs(tab, now);
      return idle !== null && idle >= threshold;
    })
    .sort((a, b) => (a.lastAccessed ?? 0) - (b.lastAccessed ?? 0));
}

/**
 * Tabs sharing a URL with another open tab, keeping the most recently used of
 * each set. Duplicates are the cheapest win in a 1000-tab strip.
 */
export async function duplicateTabs() {
  const settings = await getSettings();
  const all = await getAllTabs();
  const byUrl = new Map();

  for (const tab of all) {
    if (!tab.url) continue;
    if (settings.protectPinned && tab.pinned) continue;
    const list = byUrl.get(tab.url) ?? [];
    list.push(tab);
    byUrl.set(tab.url, list);
  }

  const dupes = [];
  for (const list of byUrl.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    dupes.push(...list.slice(1)); // keep the freshest, surface the rest
  }
  return dupes;
}

export async function getStats() {
  const [tabs, windows, groups] = await Promise.all([
    getAllTabs(),
    getAllWindows(),
    getAllGroups()
  ]);

  const discarded = tabs.filter((t) => t.discarded).length;
  const pinned = tabs.filter((t) => t.pinned).length;
  const audible = tabs.filter((t) => t.audible).length;

  const hosts = new Set();
  for (const tab of tabs) {
    const host = hostnameOf(tab.url ?? '');
    if (host) hosts.add(host);
  }

  return {
    tabs: tabs.length,
    windows: windows.length,
    groups: groups.length,
    discarded,
    loaded: tabs.length - discarded,
    pinned,
    audible,
    distinctHosts: hosts.size
  };
}

/** Snapshot of system memory. Extension-visible proxy for "did discarding help". */
export async function memoryInfo() {
  const info = await chrome.system.memory.getInfo();
  return {
    capacity: info.capacity,
    availableCapacity: info.availableCapacity,
    usedCapacity: info.capacity - info.availableCapacity,
    at: Date.now()
  };
}

export function formatBytes(bytes) {
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${bytes} B`;
  if (abs < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (abs < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined) return 'unknown';
  const days = ms / DAY_MS;
  if (days >= 1) return `${Math.floor(days)}d`;
  const hours = ms / (60 * 60 * 1000);
  if (hours >= 1) return `${Math.floor(hours)}h`;
  const mins = Math.floor(ms / 60000);
  return `${mins}m`;
}
