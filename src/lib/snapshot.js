// Undo. Rearranging a thousand tabs is irreversible by hand, so every operation
// that moves, groups, or closes tabs takes a snapshot first. See decisions/002:
// "Undo is mandatory" — the project's promise is that nothing is lost.

import { STORE_SNAPSHOTS, put, get, getAll, remove, removeMany } from './db.js';
import { getAllTabs, getAllGroups } from './tabs.js';
import { startTracking, resolveTabId, matchByUrl } from './tab-identity.js';

const MAX_SNAPSHOTS = 20;

function newId() {
  return `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Capture the current layout of every tab: which window, which position,
 * which group. This is the whole undo payload.
 */
export async function captureSnapshot(label) {
  // Tab IDs can be reassigned by a discard between capture and restore, so start
  // listening for replacements the moment we take a snapshot.
  startTracking();

  const [tabs, groups] = await Promise.all([getAllTabs(), getAllGroups()]);

  const groupsById = new Map(groups.map((g) => [g.id, g]));

  const snapshot = {
    id: newId(),
    createdAt: Date.now(),
    label,
    tabs: tabs.map((tab) => ({
      tabId: tab.id,
      url: tab.url ?? '',
      title: tab.title ?? '',
      windowId: tab.windowId,
      index: tab.index,
      groupId: tab.groupId ?? chrome.tabGroups.TAB_GROUP_ID_NONE,
      groupTitle: groupsById.get(tab.groupId)?.title ?? null,
      groupColor: groupsById.get(tab.groupId)?.color ?? null,
      pinned: tab.pinned,
      discarded: tab.discarded
    }))
  };

  await put(STORE_SNAPSHOTS, snapshot);
  await prune();
  return snapshot;
}

async function prune() {
  const all = await listSnapshots();
  if (all.length <= MAX_SNAPSHOTS) return;
  const excess = all.slice(MAX_SNAPSHOTS).map((s) => s.id);
  await removeMany(STORE_SNAPSHOTS, excess);
}

/** Newest first. */
export async function listSnapshots() {
  const all = await getAll(STORE_SNAPSHOTS);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getSnapshot(id) {
  return get(STORE_SNAPSHOTS, id);
}

export async function deleteSnapshot(id) {
  return remove(STORE_SNAPSHOTS, id);
}

/**
 * Put every tab back where it was.
 *
 * Only restores tabs that still exist — a tab closed since the snapshot is
 * reported as `missing` rather than silently recreated, because recreating it
 * would lose its history and scroll position anyway. Report honestly, don't
 * paper over it.
 *
 * Returns { restored, missing, regrouped, errors }.
 */
export async function restoreSnapshot(id) {
  const snapshot = await getSnapshot(id);
  if (!snapshot) throw new Error(`No snapshot ${id}`);

  const live = await getAllTabs();
  const liveIds = new Set(live.map((t) => t.id));

  // A tab's ID may have been reassigned since capture — discarding does this.
  // Resolve through the onReplaced map first; fall back to matching on URL,
  // which is the only thing that survives a browser restart.
  const claimed = new Set();
  const restorable = [];
  const missing = [];

  for (const entry of snapshot.tabs) {
    const resolved = resolveTabId(entry.tabId);
    if (liveIds.has(resolved) && !claimed.has(resolved)) {
      claimed.add(resolved);
      restorable.push({ ...entry, liveTabId: resolved, matchedBy: resolved === entry.tabId ? 'id' : 'onReplaced' });
      continue;
    }
    const fallback = matchByUrl(entry, live, claimed);
    if (fallback) {
      claimed.add(fallback.id);
      restorable.push({ ...entry, liveTabId: fallback.id, matchedBy: 'url' });
      continue;
    }
    missing.push(entry);
  }

  // Windows can disappear between snapshot and restore. Map any dead window
  // onto a replacement so its tabs land together rather than scattering.
  const openWindows = await chrome.windows.getAll({});
  const openWindowIds = new Set(openWindows.map((w) => w.id));
  const windowRemap = new Map();

  for (const tab of restorable) {
    if (openWindowIds.has(tab.windowId) || windowRemap.has(tab.windowId)) continue;
    const created = await chrome.windows.create({ focused: false });
    windowRemap.set(tab.windowId, {
      id: created.id,
      placeholderTabId: created.tabs?.[0]?.id ?? null
    });
  }

  const errors = [];
  let restored = 0;

  // Move in ascending original index so positions settle predictably.
  const ordered = [...restorable].sort((a, b) => a.index - b.index);

  for (const tab of ordered) {
    const targetWindowId = windowRemap.get(tab.windowId)?.id ?? tab.windowId;
    try {
      await chrome.tabs.move(tab.liveTabId, { windowId: targetWindowId, index: tab.index });
      if (tab.pinned) await chrome.tabs.update(tab.liveTabId, { pinned: true });
      restored += 1;
    } catch (err) {
      errors.push({ tabId: tab.liveTabId, title: tab.title, message: String(err?.message ?? err) });
    }
  }

  // Rebuild groups. Group ids are not stable across a regroup, so we recreate
  // by (original groupId -> set of tabs) and re-apply the title and colour.
  const byGroup = new Map();
  for (const tab of ordered) {
    if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) continue;
    const list = byGroup.get(tab.groupId) ?? [];
    list.push(tab);
    byGroup.set(tab.groupId, list);
  }

  let regrouped = 0;
  for (const [, members] of byGroup) {
    const ids = members.map((m) => m.liveTabId);
    // createProperties.windowId is REQUIRED here. Chrome's default is "the
    // current window" — the window the *caller* is in, not the window the tabs
    // are in. Omitting it drags every restored group into the dashboard's
    // window, which is the opposite of restoring a layout. Confirmed
    // empirically by the diagnostics run; see bugs/002.
    const originWindowId = members[0].windowId;
    const targetWindowId = windowRemap.get(originWindowId)?.id ?? originWindowId;
    try {
      const groupId = await chrome.tabs.group({
        tabIds: ids,
        createProperties: { windowId: targetWindowId }
      });
      const { groupTitle, groupColor } = members[0];
      const update = {};
      if (groupTitle) update.title = groupTitle;
      if (groupColor) update.color = groupColor;
      if (Object.keys(update).length) await chrome.tabGroups.update(groupId, update);
      regrouped += 1;
    } catch (err) {
      errors.push({ tabIds: ids, message: String(err?.message ?? err) });
    }
  }

  // Ungroup anything that was loose before.
  const loose = ordered
    .filter((t) => t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE)
    .map((t) => t.liveTabId);
  if (loose.length) {
    try {
      await chrome.tabs.ungroup(loose);
    } catch (err) {
      errors.push({ message: `ungroup: ${String(err?.message ?? err)}` });
    }
  }

  // Clean up the placeholder tabs of any window we had to recreate.
  for (const { placeholderTabId } of windowRemap.values()) {
    if (placeholderTabId === null) continue;
    try {
      await chrome.tabs.remove(placeholderTabId);
    } catch {
      /* window may already be gone; not worth reporting */
    }
  }

  return {
    restored,
    missing: missing.map((t) => ({ title: t.title, url: t.url })),
    regrouped,
    // How tabs were re-identified. A non-zero onReplaced/url count means IDs
    // shifted since capture — normal after a discard sweep, not an error.
    matchedBy: {
      id: restorable.filter((t) => t.matchedBy === 'id').length,
      onReplaced: restorable.filter((t) => t.matchedBy === 'onReplaced').length,
      url: restorable.filter((t) => t.matchedBy === 'url').length
    },
    errors
  };
}
