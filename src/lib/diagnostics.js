// The two questions that block the roadmap, as runnable tests.
//
//   1. Does moving or grouping a tab wake it from discard?
//      If it does, reorganizing 1000 tabs spikes RAM to the ceiling — the exact
//      opposite of the point. This gates the whole organization feature.
//
//   2. How much memory does discarding actually reclaim?
//      Validates the project's premise with a real number.
//
// Test 1 runs entirely on its own throwaway tabs. It never touches yours.

import { memoryInfo, getAllTabs, discardEligibility } from './tabs.js';
import { getSettings } from './settings.js';
import { startTracking, resolveTabId, discardAndTrack } from './tab-identity.js';

const TEST_PAGE = chrome.runtime.getURL('src/ui/test-page.html');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForComplete(tabId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return tab;
    await sleep(120);
  }
  return chrome.tabs.get(tabId);
}

/**
 * Read discard state, following any ID reassignment.
 *
 * The naive version of this (chrome.tabs.get on the original ID) is what made
 * the first run of this test report a false failure: after a discard the old ID
 * can stop existing, and "tab not found" is not the same finding as
 * "tab got reloaded".
 */
async function discardStateOf(tabIds) {
  const states = [];
  for (const id of tabIds) {
    const current = resolveTabId(id);
    try {
      const tab = await chrome.tabs.get(current);
      states.push({
        id: current,
        originalId: id,
        remapped: current !== id,
        discarded: tab.discarded === true,
        windowId: tab.windowId,
        index: tab.index
      });
    } catch {
      states.push({ id: current, originalId: id, remapped: current !== id, discarded: null, gone: true });
    }
  }
  return states;
}

function allDiscarded(states) {
  return states.length > 0 && states.every((s) => s.discarded === true);
}

/**
 * TEST 1 — does move/group preserve discard?
 *
 * Creates two scratch windows, discards scratch tabs, then subjects them to the
 * exact operations the reorganization feature will perform, checking after each.
 * Cleans up after itself in a finally block.
 */
export async function testDiscardSurvivesReorganization(log = () => {}, { pageUrl = TEST_PAGE } = {}) {
  const steps = [];
  let scratchA = null;
  let scratchB = null;
  const usingRemote = pageUrl !== TEST_PAGE;

  const record = (name, states, note = '') => {
    const survived = allDiscarded(states);
    const step = { name, survived, states, note };
    steps.push(step);
    log(step);
    return survived;
  };

  try {
    startTracking(); // must be listening before the first discard

    log({ name: 'setup', note: 'creating scratch window A' });
    scratchA = await chrome.windows.create({ url: pageUrl, focused: false });
    const anchorTab = scratchA.tabs[0];

    const t1 = await chrome.tabs.create({ url: pageUrl, windowId: scratchA.id, active: false });
    const t2 = await chrome.tabs.create({ url: pageUrl, windowId: scratchA.id, active: false });

    await Promise.all([
      waitForComplete(anchorTab.id, usingRemote ? 20000 : 8000),
      waitForComplete(t1.id, usingRemote ? 20000 : 8000),
      waitForComplete(t2.id, usingRemote ? 20000 : 8000)
    ]);

    // anchorTab stays active, so it can't be discarded — that's fine, we don't need it
    log({ name: 'discard', note: 'discarding the two inactive scratch tabs' });

    const discardResults = [];
    const subjects = [];
    for (const id of [t1.id, t2.id]) {
      const result = await discardAndTrack(id);
      discardResults.push(result);
      subjects.push(result.after ?? id);
    }

    const failedDiscards = discardResults.filter((r) => !r.ok);
    if (failedDiscards.length) {
      steps.push({ name: 'discard() call', survived: false, states: [], note: 'discard threw' });
      return {
        conclusive: false,
        verdict:
          `chrome.tabs.discard() rejected: ${failedDiscards.map((r) => r.error).join('; ')}. ` +
          'Test inconclusive — nothing was discarded to begin with.',
        steps,
        idsChanged: false
      };
    }

    // Whether discarding reassigns tab IDs is itself a finding — it dictates
    // whether ID-keyed structures (snapshots/undo) are safe.
    const idsChanged = discardResults.some((r) => r.changed);
    log({
      name: 'identity',
      note: idsChanged
        ? `discard() REASSIGNED tab IDs: ${discardResults.map((r) => `${r.before}->${r.after}`).join(', ')}`
        : 'discard() preserved tab IDs'
    });

    await sleep(250);

    const baseline = await discardStateOf(subjects);
    if (!record('baseline: after discard()', baseline, 'must be true or the test is meaningless')) {
      return {
        conclusive: false,
        verdict:
          'discard() resolved, but the tabs do not report discarded=true afterwards. Test inconclusive — ' +
          (usingRemote
            ? 'and this run already used a real website, so the cause is not extension-page-specific.'
            : 'extension pages may not be discardable in this Chrome build. Retry against a real website.'),
        steps,
        idsChanged,
        suggestRemoteRetry: !usingRemote
      };
    }

    // Re-resolve before every call: an operation can itself trigger a replace.
    const live = () => subjects.map(resolveTabId);

    // --- Operation 1: group them, same window -------------------------------
    // windowId is required: Chrome defaults to "the current window", meaning the
    // caller's window, not the tabs'. Without it the tabs teleport into the
    // dashboard's window mid-test. See bugs/002.
    const groupId = await chrome.tabs.group({
      tabIds: live(),
      createProperties: { windowId: scratchA.id }
    });
    await chrome.tabGroups.update(groupId, { title: 'chromama scratch', color: 'grey' });
    await sleep(250);
    record('after chrome.tabs.group()', await discardStateOf(subjects));

    // --- Operation 2: move the group to another window ----------------------
    log({ name: 'setup', note: 'creating scratch window B' });
    scratchB = await chrome.windows.create({ url: pageUrl, focused: false });
    await waitForComplete(scratchB.tabs[0].id);

    await chrome.tabGroups.move(groupId, { windowId: scratchB.id, index: -1 });
    await sleep(250);
    record('after chrome.tabGroups.move() across windows', await discardStateOf(subjects));

    // --- Operation 3: ungroup ----------------------------------------------
    await chrome.tabs.ungroup(live());
    await sleep(250);
    record('after chrome.tabs.ungroup()', await discardStateOf(subjects));

    // --- Operation 4: plain tab move back across windows --------------------
    await chrome.tabs.move(live(), { windowId: scratchA.id, index: -1 });
    await sleep(250);
    record('after chrome.tabs.move() across windows', await discardStateOf(subjects));

    // --- Operation 5: reorder within a window -------------------------------
    await chrome.tabs.move(resolveTabId(subjects[0]), { index: 0 });
    await sleep(250);
    record('after chrome.tabs.move() reorder in place', await discardStateOf([subjects[0]]));

    const failures = steps.filter((s) => s.survived === false);
    const idNote = idsChanged
      ? ' NOTE: discard() reassigned tab IDs — any ID-keyed state must track chrome.tabs.onReplaced.'
      : '';
    const verdict =
      failures.length === 0
        ? `PASS — discard survives every reorganization operation. Safe to build on.${idNote}`
        : `FAIL — discard was lost by: ${failures.map((f) => f.name).join(', ')}. ` +
          `Reorganizing would reload those tabs and spike memory.${idNote}`;

    return { conclusive: true, pass: failures.length === 0, verdict, steps, idsChanged };
  } catch (err) {
    return {
      conclusive: false,
      verdict: `Test errored: ${String(err?.message ?? err)}`,
      steps,
      idsChanged: false
    };
  } finally {
    for (const win of [scratchA, scratchB]) {
      if (!win) continue;
      try {
        await chrome.windows.remove(win.id);
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * TEST 2 — how much memory does a discard sweep actually reclaim?
 *
 * chrome.system.memory is system-wide, so other processes add noise. It is the
 * best signal available to an extension in stable Chrome; treat the number as
 * directional, not exact.
 *
 * This one does touch your real tabs — but only by discarding them, which is
 * reversible by clicking the tab.
 */
export async function measureDiscardSweep({ settleMs = 4000 } = {}) {
  const settings = await getSettings();

  const before = await memoryInfo();
  const tabsBefore = await getAllTabs();
  const discardedBefore = tabsBefore.filter((t) => t.discarded).length;

  const targets = tabsBefore.filter((tab) => discardEligibility(tab, settings).ok);

  startTracking();
  let discarded = 0;
  let reassignedIds = 0;
  const errors = [];
  for (const tab of targets) {
    const r = await discardAndTrack(tab.id);
    if (r.ok) {
      discarded += 1;
      if (r.changed) reassignedIds += 1;
    } else {
      errors.push({ title: tab.title, message: r.error });
    }
  }

  await sleep(settleMs); // let Chrome actually tear the renderers down

  const after = await memoryInfo();
  const tabsAfter = await getAllTabs();

  return {
    before,
    after,
    reclaimedBytes: after.availableCapacity - before.availableCapacity,
    tabsTotal: tabsBefore.length,
    discardedBefore,
    discardedAfter: tabsAfter.filter((t) => t.discarded).length,
    attempted: targets.length,
    discarded,
    reassignedIds,
    perTabBytes: discarded > 0 ? (after.availableCapacity - before.availableCapacity) / discarded : 0,
    errors
  };
}
