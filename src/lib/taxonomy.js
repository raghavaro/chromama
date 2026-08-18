// The taxonomy is the load-bearing decision of decisions/002.
//
// An AI that re-invents its categories every run shuffles tabs between windows
// every time — "Programming" one day, "Software Development" the next — and
// trust in the tool doesn't survive a week of that. So the taxonomy is a
// persisted, user-approved object. The model classifies AGAINST it, and may
// only *propose* additions, which the user approves.

import { STORE_TAXONOMY, STORE_CLASSIFICATIONS, put, get, getAll, putMany, clear } from './db.js';

const CURRENT = 'current';

/** @returns {Promise<{id, categories: Array<{name, description, color}>, updatedAt}|null>} */
export async function getTaxonomy() {
  return (await get(STORE_TAXONOMY, CURRENT)) ?? null;
}

export async function hasTaxonomy() {
  const t = await getTaxonomy();
  return Boolean(t?.categories?.length);
}

/** Tab-group colours Chrome accepts. Assigned round-robin to categories. */
export const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey'];

/**
 * Save the approved taxonomy. Categories keep a stable colour so a given topic
 * looks the same every run — part of what makes reruns feel idempotent.
 */
export async function saveTaxonomy(categories) {
  const record = {
    id: CURRENT,
    categories: categories.map((c, i) => ({
      name: String(c.name).trim(),
      description: String(c.description ?? '').trim(),
      color: c.color ?? GROUP_COLORS[i % GROUP_COLORS.length]
    })),
    updatedAt: Date.now()
  };
  await put(STORE_TAXONOMY, record);
  return record;
}

/** Add categories the user approved from a model proposal. Ignores duplicates. */
export async function addCategories(newOnes) {
  const current = (await getTaxonomy())?.categories ?? [];
  const existing = new Set(current.map((c) => c.name.toLowerCase()));
  const merged = [...current];
  for (const c of newOnes) {
    if (existing.has(String(c.name).toLowerCase())) continue;
    merged.push(c);
    existing.add(String(c.name).toLowerCase());
  }
  return saveTaxonomy(merged);
}

export async function clearTaxonomy() {
  await clear(STORE_TAXONOMY);
}

// ------------------------------------------------------------- cache

// Keyed by URL, because that is what stays stable between runs. Most tabs don't
// change, so incremental reorganization is near-free — decisions/002.

export async function getCachedClassifications() {
  const rows = await getAll(STORE_CLASSIFICATIONS);
  return new Map(rows.map((r) => [r.url, r]));
}

export async function cacheClassifications(entries) {
  if (!entries.length) return;
  await putMany(
    STORE_CLASSIFICATIONS,
    entries.map((e) => ({
      url: e.url,
      category: e.category,
      group: e.group,
      confidence: e.confidence,
      classifiedAt: Date.now()
    }))
  );
}

export async function clearClassificationCache() {
  await clear(STORE_CLASSIFICATIONS);
}

/**
 * Drop cached rows whose category is no longer in the taxonomy.
 * Called after the taxonomy changes so stale assignments don't leak through.
 */
export async function pruneCacheToTaxonomy() {
  const taxonomy = await getTaxonomy();
  if (!taxonomy) return 0;
  const valid = new Set(taxonomy.categories.map((c) => c.name));
  const rows = await getAll(STORE_CLASSIFICATIONS);
  const stale = rows.filter((r) => !valid.has(r.category));
  if (!stale.length) return 0;
  const { removeMany } = await import('./db.js');
  await removeMany(STORE_CLASSIFICATIONS, stale.map((r) => r.url));
  return stale.length;
}
