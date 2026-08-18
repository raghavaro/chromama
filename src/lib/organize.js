// Turning classifications into an actual window/group layout.
//
// Two phases on purpose: plan() shows exactly what would be sent and what would
// move, apply() does it. Nothing is transmitted or moved until the user has
// seen the plan.
//
// Two Chrome traps are load-bearing here, both found the hard way:
//   bugs/001 — tab IDs are reassigned by a discard; resolve through onReplaced
//   bugs/002 — tabs.group() defaults to the CALLER's window; always pass windowId

import { getAllTabs } from './tabs.js';
import { getSettings, isExcluded } from './settings.js';
import { getTaxonomy, getCachedClassifications, cacheClassifications, GROUP_COLORS } from './taxonomy.js';
import { classifyTabs, proposeTaxonomy, estimateTokens, DEFAULT_MODEL, CHEAP_MODEL, getApiKey } from './ai.js';
import { captureSnapshot } from './snapshot.js';
import { startTracking, resolveTabId } from './tab-identity.js';

const DASHBOARD_URL = chrome.runtime.getURL('src/ui/app.html');

// Per-million-token prices, for the cost preview only.
const PRICING = {
  [DEFAULT_MODEL]: { input: 5, output: 25 },
  [CHEAP_MODEL]: { input: 1, output: 5 }
};

/** Tabs eligible to be classified and moved. */
export async function eligibleTabs() {
  const settings = await getSettings();
  const all = await getAllTabs();

  const eligible = [];
  const held = [];

  for (const tab of all) {
    const url = tab.url ?? '';
    if (url === DASHBOARD_URL) continue; // never move our own dashboard
    if (tab.pinned) {
      held.push({ tab, reason: 'pinned' });
      continue;
    }
    if (!/^https?:/i.test(url)) {
      held.push({ tab, reason: 'not a web page' });
      continue;
    }
    if (isExcluded(url, settings.excludedDomains)) {
      held.push({ tab, reason: 'excluded domain' });
      continue;
    }
    eligible.push(tab);
  }

  return { eligible, held };
}

/**
 * What would happen, and what it would cost — without sending anything.
 */
export async function planClassification({ model = DEFAULT_MODEL } = {}) {
  const [{ eligible, held }, taxonomy, cache] = await Promise.all([
    eligibleTabs(),
    getTaxonomy(),
    getCachedClassifications()
  ]);

  const cached = eligible.filter((t) => cache.has(t.url));
  const toSend = eligible.filter((t) => !cache.has(t.url));

  const inputTokens = estimateTokens(toSend);
  const outputTokens = toSend.length * 25;
  const price = PRICING[model] ?? PRICING[DEFAULT_MODEL];
  const estCost = (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;

  return {
    hasTaxonomy: Boolean(taxonomy?.categories?.length),
    taxonomy,
    eligibleCount: eligible.length,
    heldCount: held.length,
    heldReasons: summarize(held.map((h) => h.reason)),
    cachedCount: cached.length,
    toSendCount: toSend.length,
    toSend, // the exact rows that would leave the machine
    inputTokens,
    outputTokens,
    estCost,
    model
  };
}

function summarize(reasons) {
  const counts = new Map();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()].map(([reason, n]) => ({ reason, n }));
}

/** Ask the model to propose a taxonomy from a sample of real tabs. */
export async function proposeTaxonomyFromTabs({ model = DEFAULT_MODEL, sampleSize = 400 } = {}) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('No API key set. Add one under Settings.');

  const { eligible } = await eligibleTabs();
  if (!eligible.length) throw new Error('No eligible tabs to learn from.');

  // Even spread across the strip rather than the first N, so a sample isn't
  // dominated by whatever the user opened most recently.
  const step = Math.max(1, Math.floor(eligible.length / sampleSize));
  const sample = eligible.filter((_, i) => i % step === 0).slice(0, sampleSize);

  const { categories, usage } = await proposeTaxonomy({ apiKey, model, tabs: sample });
  return {
    categories: categories.map((c, i) => ({ ...c, color: GROUP_COLORS[i % GROUP_COLORS.length] })),
    sampledFrom: sample.length,
    of: eligible.length,
    usage
  };
}

/**
 * Classify everything not already cached, then merge with the cache.
 * Returns assignments for every eligible tab.
 */
export async function runClassification({ model = DEFAULT_MODEL, onProgress = () => {} } = {}) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('No API key set. Add one under Settings.');

  const taxonomy = await getTaxonomy();
  if (!taxonomy?.categories?.length) throw new Error('No taxonomy yet. Propose and approve one first.');

  const { eligible } = await eligibleTabs();
  const cache = await getCachedClassifications();

  const toSend = eligible.filter((t) => !cache.has(t.url));
  let fresh = { assignments: [], proposedCategories: [], usage: {}, batches: 0 };

  if (toSend.length) {
    fresh = await classifyTabs({
      apiKey,
      model,
      tabs: toSend,
      categories: taxonomy.categories,
      onProgress
    });
    await cacheClassifications(fresh.assignments);
  }

  const byUrl = new Map(fresh.assignments.map((a) => [a.url, a]));
  const assignments = eligible
    .map((tab) => {
      const hit = byUrl.get(tab.url) ?? cache.get(tab.url);
      if (!hit) return null;
      return {
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        category: hit.category,
        group: hit.group,
        confidence: hit.confidence,
        fromCache: !byUrl.has(tab.url)
      };
    })
    .filter(Boolean);

  return {
    assignments,
    proposedCategories: fresh.proposedCategories ?? [],
    usage: fresh.usage,
    batches: fresh.batches,
    sentCount: toSend.length,
    cachedCount: assignments.length - toSend.length
  };
}

/**
 * Turn assignments into a concrete move plan, without touching anything.
 *
 * Target window per category is the window that already holds the most tabs of
 * that category — minimising how much actually moves. Only creates a window
 * when a category has no home yet.
 */
export async function planLayout(assignments, { minGroupSize = 2 } = {}) {
  const taxonomy = await getTaxonomy();
  const colorOf = new Map((taxonomy?.categories ?? []).map((c) => [c.name, c.color]));

  const byCategory = new Map();
  for (const a of assignments) {
    const list = byCategory.get(a.category) ?? [];
    list.push(a);
    byCategory.set(a.category, list);
  }

  const tabs = await getAllTabs();
  const windowOfTab = new Map(tabs.map((t) => [t.id, t.windowId]));

  const plan = [];
  const usedWindows = new Set();

  for (const [category, members] of byCategory) {
    // Which window already holds most of this category?
    const tally = new Map();
    for (const m of members) {
      const w = windowOfTab.get(m.tabId);
      if (w === undefined) continue;
      tally.set(w, (tally.get(w) ?? 0) + 1);
    }
    let home = null;
    let best = 0;
    for (const [w, n] of tally) {
      if (n > best && !usedWindows.has(w)) {
        best = n;
        home = w;
      }
    }
    if (home !== null) usedWindows.add(home);

    // Sub-groups within the category.
    const byGroup = new Map();
    for (const m of members) {
      const list = byGroup.get(m.group) ?? [];
      list.push(m);
      byGroup.set(m.group, list);
    }
    const groups = [...byGroup.entries()]
      .map(([name, gm]) => ({ name, members: gm }))
      .sort((a, b) => b.members.length - a.members.length);

    plan.push({
      category,
      color: colorOf.get(category) ?? 'grey',
      existingWindowId: home,
      willCreateWindow: home === null,
      tabCount: members.length,
      movingCount: members.filter((m) => windowOfTab.get(m.tabId) !== home).length,
      groups: groups.map((g) => ({
        name: g.name,
        count: g.members.length,
        willGroup: g.members.length >= minGroupSize
      })),
      members
    });
  }

  return plan.sort((a, b) => b.tabCount - a.tabCount);
}

/**
 * Execute a layout plan. Snapshots first — undo is mandatory (decisions/002).
 */
export async function applyLayout(plan, { minGroupSize = 2, onProgress = () => {} } = {}) {
  startTracking();
  const snapshot = await captureSnapshot(`before organizing ${plan.reduce((n, p) => n + p.tabCount, 0)} tabs`);

  const errors = [];
  let movedTabs = 0;
  let createdWindows = 0;
  let createdGroups = 0;

  for (const entry of plan) {
    onProgress({ category: entry.category });

    // --- resolve the target window ---------------------------------------
    let windowId = entry.existingWindowId;
    if (windowId === null || windowId === undefined) {
      try {
        const created = await chrome.windows.create({ focused: false });
        windowId = created.id;
        createdWindows += 1;
        // Park the placeholder; removed once real tabs have landed.
        entry._placeholderTabId = created.tabs?.[0]?.id ?? null;
      } catch (err) {
        errors.push({ category: entry.category, message: `create window: ${String(err?.message ?? err)}` });
        continue;
      }
    }

    // --- move the tabs in --------------------------------------------------
    const ids = entry.members.map((m) => resolveTabId(m.tabId));
    try {
      await chrome.tabs.move(ids, { windowId, index: -1 });
      movedTabs += ids.length;
    } catch (err) {
      errors.push({ category: entry.category, message: `move: ${String(err?.message ?? err)}` });
    }

    // --- build the sub-groups ---------------------------------------------
    for (const group of entry.groups) {
      if (group.count < minGroupSize) continue; // a one-tab group is noise
      const members = entry.members.filter((m) => m.group === group.name);
      const groupIds = members.map((m) => resolveTabId(m.tabId));
      try {
        // windowId is REQUIRED — Chrome otherwise groups into the *caller's*
        // window and undoes the move we just made. See bugs/002.
        const groupId = await chrome.tabs.group({
          tabIds: groupIds,
          createProperties: { windowId }
        });
        await chrome.tabGroups.update(groupId, {
          title: group.name,
          color: entry.color,
          collapsed: true // collapsed is the point — this is what reclaims the strip
        });
        createdGroups += 1;
      } catch (err) {
        errors.push({ category: entry.category, group: group.name, message: String(err?.message ?? err) });
      }
    }

    if (entry._placeholderTabId) {
      try {
        await chrome.tabs.remove(entry._placeholderTabId);
      } catch {
        /* fine */
      }
    }
  }

  return { snapshotId: snapshot.id, movedTabs, createdWindows, createdGroups, errors };
}
