// Dashboard. This is an extension page, so it has full chrome.* access and
// calls the libs directly — no message passing through the service worker.

import {
  getStats,
  staleTabs,
  duplicateTabs,
  discardEligibleTabs,
  formatBytes,
  formatDuration,
  idleMs
} from '../lib/tabs.js';
import { getSettings, saveSettings } from '../lib/settings.js';
import { captureSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot } from '../lib/snapshot.js';
import { archiveTabs, listArchive, archiveCount, restoreArchived, deleteArchived } from '../lib/archive.js';
import { testDiscardSurvivesReorganization, measureDiscardSweep } from '../lib/diagnostics.js';
import { getTaxonomy, saveTaxonomy, addCategories, pruneCacheToTaxonomy, GROUP_COLORS } from '../lib/taxonomy.js';
import { getApiKey, setApiKey } from '../lib/ai.js';
import {
  planClassification,
  proposeTaxonomyFromTabs,
  runClassification,
  planLayout,
  applyLayout
} from '../lib/organize.js';

const $ = (id) => document.getElementById(id);

function show(el, html) {
  el.hidden = false;
  el.innerHTML = html;
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// ---------------------------------------------------------------- stats

async function renderStats() {
  const s = await getStats();
  const cells = [
    ['tabs', s.tabs],
    ['windows', s.windows],
    ['groups', s.groups],
    ['loaded', s.loaded],
    ['discarded', s.discarded],
    ['pinned', s.pinned],
    ['distinct hosts', s.distinctHosts]
  ];
  $('stats').innerHTML = cells
    .map(([k, n]) => `<div class="stat"><div class="n">${n}</div><div class="k">${k}</div></div>`)
    .join('');
}

// ---------------------------------------------------- diagnostics: test 1

async function runDiscardTest({ pageUrl = undefined } = {}) {
  const btn = $('run-discard-test');
  const btnRemote = $('run-discard-test-remote');
  const out = $('out-discard-test');
  btn.disabled = true;
  btnRemote.disabled = true;
  show(out, 'Running… two scratch windows will open and close.\n\n');

  const lines = [];
  const append = (step) => {
    if (step.survived === undefined) {
      lines.push(`  · ${step.note ?? step.name}`);
    } else {
      lines.push(`  ${step.survived ? '✓' : '✗'} ${step.name}${step.survived ? '' : '  <-- DISCARD LOST'}`);
    }
    out.textContent = lines.join('\n');
  };

  try {
    const result = await testDiscardSurvivesReorganization(append, pageUrl ? { pageUrl } : {});
    const cls = !result.conclusive ? 'unknown' : result.pass ? 'pass' : 'fail';
    show(
      out,
      `<div class="verdict ${cls}">${esc(result.verdict)}</div>` +
        esc(lines.join('\n')) +
        (result.steps.length
          ? `\n\n${esc(
              result.steps
                .filter((s) => s.states)
                .map(
                  (s) =>
                    `${s.name}\n` +
                    s.states
                      .map(
                        (st) =>
                          `    tab ${st.id}${st.remapped ? ` (was ${st.originalId})` : ''}: ` +
                          `discarded=${st.discarded}${st.gone ? ' GONE' : ''} window=${st.windowId ?? '-'}`
                      )
                      .join('\n')
                )
                .join('\n\n')
            )}`
          : '')
    );
  } catch (err) {
    show(out, `<div class="verdict fail">Errored: ${esc(err?.message ?? err)}</div>`);
  } finally {
    btn.disabled = false;
    btnRemote.disabled = false;
    renderStats();
  }
}

$('run-discard-test').addEventListener('click', () => runDiscardTest());

// Fallback: if extension pages turn out not to be discardable in this Chrome
// build, rerun the identical test against a real website. Needs network.
$('run-discard-test-remote').addEventListener('click', () =>
  runDiscardTest({ pageUrl: 'https://example.com/' })
);

// ---------------------------------------------------- diagnostics: test 2

$('run-memory-test').addEventListener('click', async () => {
  const btn = $('run-memory-test');
  const out = $('out-memory-test');
  if (!confirm('This will discard every eligible tab. They stay in the tab strip and reload when clicked. Continue?')) {
    return;
  }
  btn.disabled = true;
  show(out, 'Sampling memory, discarding, waiting 4s for renderers to tear down…');

  try {
    const r = await measureDiscardSweep();
    const perTab = r.discarded > 0 ? formatBytes(r.perTabBytes) : 'n/a';
    const gained = r.reclaimedBytes >= 0;
    show(
      out,
      `<div class="verdict ${gained ? 'pass' : 'unknown'}">` +
        `${gained ? 'Reclaimed' : 'Net change'} ${esc(formatBytes(r.reclaimedBytes))} across ${r.discarded} tabs — ~${esc(perTab)}/tab` +
        `</div>` +
        esc(
          [
            `tabs total            ${r.tabsTotal}`,
            `discarded before      ${r.discardedBefore}`,
            `discarded after       ${r.discardedAfter}`,
            `eligible this run     ${r.attempted}`,
            `discarded this run    ${r.discarded}`,
            `ids reassigned        ${r.reassignedIds}`,
            ``,
            `available before      ${formatBytes(r.before.availableCapacity)}`,
            `available after       ${formatBytes(r.after.availableCapacity)}`,
            `system capacity       ${formatBytes(r.before.capacity)}`,
            ``,
            `System-wide measurement — other processes add noise. Directional, not exact.`,
            r.errors.length ? `\n${r.errors.length} error(s):\n` + r.errors.map((e) => `  ${e.title}: ${e.message}`).join('\n') : ''
          ].join('\n')
        )
    );
  } catch (err) {
    show(out, `<div class="verdict fail">Errored: ${esc(err?.message ?? err)}</div>`);
  } finally {
    btn.disabled = false;
    renderStats();
  }
});

// --------------------------------------------------------------- organize

let lastAssignments = null; // set by classify, consumed by apply

function parseTaxonomyText(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      const idx = line.indexOf(':');
      const name = (idx === -1 ? line : line.slice(0, idx)).trim();
      const description = idx === -1 ? '' : line.slice(idx + 1).trim();
      return { name, description, color: GROUP_COLORS[i % GROUP_COLORS.length] };
    })
    .filter((c) => c.name);
}

async function renderTaxonomy() {
  const t = await getTaxonomy();
  const view = $('taxonomy-view');
  if (!t?.categories?.length) {
    view.innerHTML = '<p class="empty">No taxonomy yet. Propose one, edit it, then save.</p>';
    return;
  }
  view.innerHTML = t.categories
    .map(
      (c) =>
        `<div class="cat"><span class="swatch" style="background:${esc(c.color)}"></span>` +
        `<strong>${esc(c.name)}</strong><span class="desc">${esc(c.description)}</span></div>`
    )
    .join('');
  if (!$('taxonomy-edit').value.trim()) {
    $('taxonomy-edit').value = t.categories.map((c) => `${c.name}: ${c.description}`).join('\n');
  }
}

$('btn-plan').addEventListener('click', async () => {
  const p = await planClassification();
  show(
    $('out-plan'),
    esc(
      [
        `eligible tabs         ${p.eligibleCount}`,
        `held back             ${p.heldCount}   (${p.heldReasons.map((h) => `${h.n} ${h.reason}`).join(', ') || 'none'})`,
        `already classified    ${p.cachedCount}   (cached by URL — free)`,
        `would be sent         ${p.toSendCount}`,
        ``,
        `est. input tokens     ${p.inputTokens.toLocaleString()}`,
        `est. output tokens    ${p.outputTokens.toLocaleString()}`,
        `est. cost             $${p.estCost.toFixed(3)}   (${p.model})`,
        ``,
        p.hasTaxonomy ? `taxonomy              ${p.taxonomy.categories.length} categories` : `taxonomy              NONE — propose one first`,
        ``,
        `Nothing has been sent. Held-back tabs never leave the machine.`
      ].join('\n')
    )
  );
});

$('btn-plan-list').addEventListener('click', async () => {
  const p = await planClassification();
  show(
    $('out-plan'),
    `<div class="verdict unknown">These ${p.toSendCount} title+URL pairs would be sent. Nothing sent yet.</div>` +
      esc(p.toSend.map((t) => `${t.title}\n    ${t.url}`).join('\n'))
  );
});

$('btn-propose').addEventListener('click', async () => {
  const btn = $('btn-propose');
  btn.disabled = true;
  show($('out-taxonomy'), 'Sampling your tabs and proposing categories…');
  try {
    const r = await proposeTaxonomyFromTabs();
    $('taxonomy-edit').value = r.categories.map((c) => `${c.name}: ${c.description}`).join('\n');
    show(
      $('out-taxonomy'),
      `<div class="verdict unknown">Proposed ${r.categories.length} categories from ${r.sampledFrom} of ${r.of} tabs. Nothing saved yet — edit above, then Save.</div>` +
        esc(r.categories.map((c) => `${c.name}\n    ${c.rationale}`).join('\n\n'))
    );
  } catch (err) {
    show($('out-taxonomy'), `<div class="verdict fail">${esc(err?.message ?? err)}</div>`);
  } finally {
    btn.disabled = false;
  }
});

$('btn-save-taxonomy').addEventListener('click', async () => {
  const categories = parseTaxonomyText($('taxonomy-edit').value);
  if (!categories.length) {
    show($('out-taxonomy'), '<div class="verdict fail">Nothing to save — add at least one category.</div>');
    return;
  }
  await saveTaxonomy(categories);
  const pruned = await pruneCacheToTaxonomy();
  show(
    $('out-taxonomy'),
    esc(
      `Saved ${categories.length} categories.` +
        (pruned ? ` Dropped ${pruned} cached classification(s) referencing categories that no longer exist.` : '')
    )
  );
  renderTaxonomy();
});

$('btn-classify').addEventListener('click', async () => {
  const btn = $('btn-classify');
  btn.disabled = true;
  $('btn-apply').disabled = true;
  show($('out-organize'), 'Classifying…');
  try {
    const r = await runClassification({
      onProgress: ({ done, total }) => {
        $('out-organize').textContent = `Classifying… ${done}/${total}`;
      }
    });
    lastAssignments = r.assignments;

    const plan = await planLayout(r.assignments);
    const layout = plan
      .map(
        (p) =>
          `${p.category}  (${p.tabCount} tabs, ${p.movingCount} moving)` +
          `${p.willCreateWindow ? '  [new window]' : ''}\n` +
          p.groups.map((g) => `      ${g.willGroup ? '▸' : '·'} ${g.name} (${g.count})`).join('\n')
      )
      .join('\n\n');

    show(
      $('out-organize'),
      `<div class="verdict unknown">Classified ${r.assignments.length} tabs — ${r.sentCount} sent, ${r.cachedCount} from cache. Nothing has moved yet.</div>` +
        esc(
          layout +
            `\n\ntokens  in ${r.usage.input_tokens ?? 0}  out ${r.usage.output_tokens ?? 0}  cached ${r.usage.cache_read_input_tokens ?? 0}` +
            (r.proposedCategories.length
              ? `\n\nThe model proposed ${r.proposedCategories.length} new categor(ies):\n` +
                r.proposedCategories.map((c) => `  ${c.name}: ${c.description}\n      ${c.rationale}`).join('\n')
              : '')
        ) +
        (r.proposedCategories.length
          ? `<div class="row"><button class="small" id="btn-accept-cats">Add ${r.proposedCategories.length} proposed categor(ies)</button></div>`
          : '')
    );

    $('btn-accept-cats')?.addEventListener('click', async () => {
      await addCategories(r.proposedCategories);
      await renderTaxonomy();
      $('taxonomy-edit').value = '';
      await renderTaxonomy();
      show($('out-organize'), esc('Categories added. Re-run Classify so the new ones get used.'));
    });

    $('btn-apply').disabled = r.assignments.length === 0;
  } catch (err) {
    show($('out-organize'), `<div class="verdict fail">${esc(err?.message ?? err)}</div>`);
  } finally {
    btn.disabled = false;
  }
});

$('btn-apply').addEventListener('click', async () => {
  if (!lastAssignments?.length) return;
  if (!confirm(`Move ${lastAssignments.length} tabs into topic windows and groups? A snapshot is taken first, so this is undoable.`)) {
    return;
  }
  const btn = $('btn-apply');
  btn.disabled = true;
  show($('out-organize'), 'Applying…');
  try {
    const plan = await planLayout(lastAssignments);
    const r = await applyLayout(plan, {
      onProgress: ({ category }) => {
        $('out-organize').textContent = `Applying… ${category}`;
      }
    });
    show(
      $('out-organize'),
      `<div class="verdict pass">Moved ${r.movedTabs} tabs · ${r.createdWindows} new window(s) · ${r.createdGroups} group(s)</div>` +
        esc(
          `Undo is available under Snapshots (${r.snapshotId}).` +
            (r.errors.length ? `\n\n${r.errors.length} error(s):\n` + r.errors.map((e) => `  ${e.category}${e.group ? '/' + e.group : ''}: ${e.message}`).join('\n') : '')
        )
    );
    renderAll();
  } catch (err) {
    show($('out-organize'), `<div class="verdict fail">${esc(err?.message ?? err)}</div>`);
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- actions

$('btn-discard').addEventListener('click', async () => {
  const r = await discardEligibleTabs();
  show(
    $('out-actions'),
    esc(
      `Discarded ${r.discarded} of ${r.attempted} eligible.\n` +
        `Skipped ${r.skipped.length} (active, pinned, audible, or already discarded).` +
        (r.reassignedIds ? `\n${r.reassignedIds} tab(s) were reassigned a new ID by the discard.` : '') +
        (r.errors.length ? `\n${r.errors.length} error(s): ${r.errors.map((e) => e.message).join('; ')}` : '')
    )
  );
  renderStats();
});

$('btn-snapshot').addEventListener('click', async () => {
  const snap = await captureSnapshot('manual');
  show($('out-actions'), esc(`Snapshot ${snap.id} — ${snap.tabs.length} tabs captured.`));
  renderSnapshots();
});

$('btn-refresh').addEventListener('click', () => {
  renderAll();
});

// ------------------------------------------------------------- candidates

function candidateList(title, tabs, actionLabel) {
  if (!tabs.length) return `<p class="empty">No ${title} found.</p>`;
  const rows = tabs
    .slice(0, 200)
    .map(
      (t) =>
        `<div class="item">` +
        (t.favIconUrl ? `<img src="${esc(t.favIconUrl)}" alt="" />` : `<span style="width:16px"></span>`) +
        `<span class="title">${esc(t.title || t.url)}</span>` +
        `<span class="meta">${esc(formatDuration(idleMs(t)))} idle</span>` +
        `</div>`
    )
    .join('');
  return (
    `<p class="note">${tabs.length} ${title}${tabs.length > 200 ? ' (showing first 200)' : ''}</p>` +
    rows +
    `<div class="row"><button class="small" data-archive-all="1">${actionLabel} all ${tabs.length}</button></div>`
  );
}

async function wireArchiveAll(container, tabs) {
  const btn = container.querySelector('[data-archive-all]');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!confirm(`Archive and close ${tabs.length} tabs? A snapshot is taken first, so this is undoable.`)) return;
    await captureSnapshot(`before archiving ${tabs.length} tabs`);
    const r = await archiveTabs(tabs.map((t) => t.id));
    container.innerHTML =
      `<p class="empty">Archived ${r.archived}.` +
      (r.refused.length ? ` Held back ${r.refused.length}: ${esc(r.refused.map((x) => x.reason).join(', '))}.` : '') +
      `</p>`;
    renderAll();
  });
}

$('btn-find-stale').addEventListener('click', async () => {
  const settings = await getSettings();
  const tabs = await staleTabs();
  const el = $('candidates');
  el.innerHTML = candidateList(`tabs idle over ${settings.staleAfterDays} days`, tabs, 'Archive');
  wireArchiveAll(el, tabs);
});

$('btn-find-dupes').addEventListener('click', async () => {
  const tabs = await duplicateTabs();
  const el = $('candidates');
  el.innerHTML = candidateList('duplicate tabs (freshest of each URL kept)', tabs, 'Archive');
  wireArchiveAll(el, tabs);
});

// ---------------------------------------------------------------- archive

async function renderArchive() {
  const [records, n] = await Promise.all([listArchive(), archiveCount()]);
  $('archive-count').textContent = n ? `— ${n}` : '';
  const el = $('archive-list');

  if (!records.length) {
    el.innerHTML = '<p class="empty">Nothing archived yet.</p>';
    return;
  }

  el.innerHTML =
    `<div class="row"><button class="small" id="restore-all">Restore all ${records.length}</button></div>` +
    records
      .slice(0, 300)
      .map(
        (r) =>
          `<div class="item">` +
          (r.favIconUrl ? `<img src="${esc(r.favIconUrl)}" alt="" />` : `<span style="width:16px"></span>`) +
          `<span class="title" title="${esc(r.url)}">${esc(r.title)}</span>` +
          `<span class="meta">${esc(r.host)}</span>` +
          `<button class="small ghost" data-restore="${esc(r.id)}">Restore</button>` +
          `<button class="small ghost" data-forget="${esc(r.id)}">Forget</button>` +
          `</div>`
      )
      .join('');

  el.querySelector('#restore-all')?.addEventListener('click', async () => {
    await restoreArchived(records.map((r) => r.id));
    renderAll();
  });
  el.querySelectorAll('[data-restore]').forEach((b) =>
    b.addEventListener('click', async () => {
      await restoreArchived([b.dataset.restore]);
      renderAll();
    })
  );
  el.querySelectorAll('[data-forget]').forEach((b) =>
    b.addEventListener('click', async () => {
      await deleteArchived(b.dataset.forget);
      renderArchive();
    })
  );
}

// -------------------------------------------------------------- snapshots

async function renderSnapshots() {
  const snaps = await listSnapshots();
  const el = $('snapshot-list');

  if (!snaps.length) {
    el.innerHTML = '<p class="empty">No snapshots yet. One is taken automatically before anything destructive.</p>';
    return;
  }

  el.innerHTML = snaps
    .map(
      (s) =>
        `<div class="item">` +
        `<span class="title">${esc(s.label)}</span>` +
        `<span class="meta">${s.tabs.length} tabs · ${esc(new Date(s.createdAt).toLocaleString())}</span>` +
        `<button class="small" data-undo="${esc(s.id)}">Restore</button>` +
        `<button class="small ghost" data-drop="${esc(s.id)}">Delete</button>` +
        `</div>`
    )
    .join('');

  el.querySelectorAll('[data-undo]').forEach((b) =>
    b.addEventListener('click', async () => {
      const r = await restoreSnapshot(b.dataset.undo);
      const shifted = r.matchedBy.onReplaced + r.matchedBy.url;
      alert(
        `Restored ${r.restored} tabs, rebuilt ${r.regrouped} groups.` +
          (shifted
            ? `\n${shifted} tab(s) had been reassigned a new ID since capture ` +
              `(${r.matchedBy.onReplaced} via onReplaced, ${r.matchedBy.url} by URL) — normal after a discard.`
            : '') +
          (r.missing.length ? `\n${r.missing.length} tab(s) no longer exist and were not recreated.` : '') +
          (r.errors.length ? `\n${r.errors.length} error(s).` : '')
      );
      renderAll();
    })
  );
  el.querySelectorAll('[data-drop]').forEach((b) =>
    b.addEventListener('click', async () => {
      await deleteSnapshot(b.dataset.drop);
      renderSnapshots();
    })
  );
}

// --------------------------------------------------------------- settings

async function renderSettings() {
  const s = await getSettings();
  $('set-stale-days').value = s.staleAfterDays;
  $('set-excluded').value = s.excludedDomains.join('\n');
  $('set-api-key').value = await getApiKey();
}

$('btn-save-settings').addEventListener('click', async () => {
  const excluded = $('set-excluded')
    .value.split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const days = Math.max(1, Number($('set-stale-days').value) || 14);
  await saveSettings({ excludedDomains: excluded, staleAfterDays: days });
  await setApiKey($('set-api-key').value);
  show(
    $('out-settings'),
    esc(
      `Saved. ${excluded.length} excluded domain(s), stale after ${days} days, ` +
        `API key ${$('set-api-key').value.trim() ? 'set' : 'cleared'}.`
    )
  );
});

// -------------------------------------------------------------------- run

async function renderAll() {
  await Promise.all([renderStats(), renderArchive(), renderSnapshots(), renderSettings(), renderTaxonomy()]);
}

renderAll();
