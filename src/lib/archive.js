// Archiving: close a tab and keep enough state to bring it back.
// This is the "reclaim attention" job, distinct from discarding.

import { STORE_ARCHIVE, put, putMany, getAll, remove, removeMany, count } from './db.js';
import { getSettings, isExcluded, hostnameOf } from './settings.js';
import { getAllGroups } from './tabs.js';

function newId() {
  return `arc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Archive the given tabs, then close them.
 *
 * Excluded domains are refused, not silently skipped — the caller is told what
 * was held back and why.
 */
export async function archiveTabs(tabIds) {
  const settings = await getSettings();
  const groups = await getAllGroups();
  const groupsById = new Map(groups.map((g) => [g.id, g]));

  const tabs = [];
  for (const id of tabIds) {
    try {
      tabs.push(await chrome.tabs.get(id));
    } catch {
      /* tab closed between selection and action */
    }
  }

  const refused = [];
  const keepers = [];

  for (const tab of tabs) {
    if (settings.protectPinned && tab.pinned) {
      refused.push({ title: tab.title, reason: 'pinned' });
      continue;
    }
    if (isExcluded(tab.url ?? '', settings.excludedDomains)) {
      refused.push({ title: tab.title, reason: 'excluded domain' });
      continue;
    }
    keepers.push(tab);
  }

  const records = keepers.map((tab) => {
    const group = groupsById.get(tab.groupId);
    return {
      id: newId(),
      url: tab.url ?? '',
      title: tab.title ?? '(untitled)',
      favIconUrl: tab.favIconUrl ?? null,
      host: hostnameOf(tab.url ?? ''),
      archivedAt: Date.now(),
      lastAccessed: tab.lastAccessed ?? null,
      groupTitle: group?.title ?? null,
      groupColor: group?.color ?? null,
      wasDiscarded: tab.discarded === true
    };
  });

  if (records.length) await putMany(STORE_ARCHIVE, records);

  const closeIds = keepers.map((t) => t.id);
  if (closeIds.length) await chrome.tabs.remove(closeIds);

  return { archived: records.length, refused, records };
}

/** Newest first. */
export async function listArchive() {
  const all = await getAll(STORE_ARCHIVE);
  return all.sort((a, b) => b.archivedAt - a.archivedAt);
}

export async function archiveCount() {
  return count(STORE_ARCHIVE);
}

/**
 * Reopen archived entries.
 *
 * Opens them discarded where possible so restoring 200 tabs doesn't load 200
 * pages at once — the whole point is to not spike memory on the way back in.
 */
export async function restoreArchived(ids, { windowId = null, removeAfter = true } = {}) {
  const all = await listArchive();
  const byId = new Map(all.map((r) => [r.id, r]));

  let targetWindowId = windowId;
  if (targetWindowId === null) {
    const created = await chrome.windows.create({ focused: true });
    targetWindowId = created.id;
    const placeholder = created.tabs?.[0]?.id;
    if (placeholder !== undefined) {
      // Close after the first real tab lands, so the window never goes empty.
      setTimeout(() => chrome.tabs.remove(placeholder).catch(() => {}), 0);
    }
  }

  const errors = [];
  const opened = [];

  for (const id of ids) {
    const record = byId.get(id);
    if (!record) continue;
    try {
      const tab = await chrome.tabs.create({
        url: record.url,
        windowId: targetWindowId,
        active: false
      });
      opened.push(tab.id);
    } catch (err) {
      errors.push({ id, title: record.title, message: String(err?.message ?? err) });
    }
  }

  if (removeAfter && opened.length) {
    const restoredIds = ids.filter((id) => byId.has(id));
    await removeMany(STORE_ARCHIVE, restoredIds);
  }

  return { opened: opened.length, windowId: targetWindowId, errors };
}

export async function deleteArchived(id) {
  return remove(STORE_ARCHIVE, id);
}

export async function putArchived(record) {
  return put(STORE_ARCHIVE, record);
}
