# chromama

Reclaim RAM and attention from a thousand open tabs.

An unpacked Chrome extension (Manifest V3). No build step, no dependencies — edit a file, hit reload.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this directory
4. Click the extension icon to open the dashboard

## Run the two blocking tests first

Both live under **Diagnostics** on the dashboard. Neither has been run yet — the
answers determine whether the reorganization feature is viable at all.

**1. Does move/group preserve discard?** — Creates two throwaway windows with its
own scratch tabs, discards them, then puts them through the exact operations the
reorganization feature will perform (`tabs.group`, `tabGroups.move` across
windows, `ungroup`, `tabs.move` across windows, reorder in place), checking
`tab.discarded` after each. Cleans up after itself. **Never touches your tabs.**

If this fails, reorganizing 1000 tabs would reload all of them and spike memory —
the exact opposite of the point — and the design in `decisions/002` needs rework.

The test also reports, separately, **whether `discard()` reassigned the tab IDs**.
That is its own finding: the first run of this test failed spuriously because the
harness held IDs across a discard and `chrome.tabs.get()` then threw. "Tab not
found" is not the same finding as "tab got reloaded", and the test now
distinguishes them. See `src/lib/tab-identity.js`.

**Retry vs. real site** reruns the identical test against `example.com` instead
of a bundled extension page, in case extension pages aren't discardable in a
given Chrome build. Needs network.

**2. How much does a discard sweep reclaim?** — Samples `chrome.system.memory`,
discards every eligible tab, waits for renderers to tear down, samples again.
This one *does* touch your real tabs, but discarding is reversible: click a tab
and it reloads. The measurement is system-wide, so other processes add noise —
treat it as directional.

## What's here

```
manifest.json
src/
  background/service-worker.js   thin: opens the dashboard, owns no state
  lib/
    db.js            IndexedDB wrapper (archive + snapshots)
    settings.js      chrome.storage.local; excluded-domain list
    tab-identity.js  tab IDs are NOT stable across a discard — track onReplaced
    tabs.js          discard, stale/duplicate heuristics, stats, memory
    snapshot.js      undo — capture and restore full tab layout
    archive.js       close-and-keep, and restore
    diagnostics.js   the two tests above
    taxonomy.js      the persisted, user-approved category set + URL cache
    ai.js            Claude API client — transmits, never decides what to send
    organize.js      plan/apply layout; owns the privacy filter
  ui/
    app.html/css/js  the dashboard
    test-page.html   scratch page used by test 1
```

## Design notes

The two jobs this separates (see the local vault, `.claudevault/decisions/001`):

| Job | Mechanism | Posture |
|---|---|---|
| Reclaim RAM | `chrome.tabs.discard()` — tab stays in the strip | Aggressive, automatic, low-stakes (worst case: a reload) |
| Reclaim attention | Close + archive to IndexedDB | Conservative, for tabs untouched in weeks |

Other decisions worth knowing while reading the code:

- **Undo is mandatory.** Every destructive action snapshots `(tabId → windowId, index, groupId, pinned)` first. Restore puts tabs back and rebuilds groups; tabs that no longer exist are *reported*, not silently recreated.
- **Tab IDs are not stable across a discard.** Chrome can swap a discarded tab for a replacement and reassign its ID, announced via `chrome.tabs.onReplaced`. Anything holding an ID across a discard — the snapshot/undo system above, the diagnostics harness — is wrong without tracking that. `tab-identity.js` maintains the remap and falls back to URL matching, which is the only thing that survives a browser restart.
- **Excluded domains exist before the AI does.** `settings.js` ships a default list (mail, accounts, WhatsApp, localhost). Those are never archived, and once the AI layer lands their URLs and titles never leave the machine. Built now on purpose.
- **Heuristics before models.** Stale-tab and duplicate detection involve no AI at all. A large share of 1000 tabs are likely duplicates and dead ends that need no model.
- **The dashboard calls the libs directly.** It's an extension page with full `chrome.*` access, so there's no message-passing layer. The MV3 service worker terminates after ~30s idle and therefore owns nothing stateful.

## Organizing by topic

Both blocking tests passed, so this is built. Add an Anthropic API key under
Settings, then work down the **Organize by topic** panel:

1. **Preview** — dry run. Shows how many tabs would be sent, the token count, the
   cost, and (via *Show the exact URLs*) precisely which title+URL pairs would
   leave the machine. Sends nothing.
2. **Taxonomy** — *Propose from my tabs* samples your tabs evenly across the strip
   and suggests 5–10 categories. **Edit them, then Save.** This is the
   load-bearing step: the saved taxonomy is what makes re-runs idempotent instead
   of reshuffling everything (`decisions/002`).
3. **Classify** — assigns each tab a category and a sub-group, batched 200 at a
   time. Results are cached by URL, so a second run costs almost nothing. Shows
   the full layout before anything moves. If the model spots a coherent theme
   your taxonomy misses, it proposes it for your approval rather than inventing
   one silently.
4. **Apply** — moves tabs into per-category windows and collapsed per-task groups.
   Snapshots first; undo lives under Snapshots.

Categories that don't fit are never forced: a tab the model can't place gets its
closest category with a confidence below 0.4, and a returned category that isn't
in your taxonomy is discarded rather than applied.

**What never gets sent:** pinned tabs, non-`http(s)` tabs, the dashboard itself,
and anything matching your excluded-domain list. That filter lives in
`organize.js`, deliberately not in `ai.js` — the module that decides what is safe
to send should not be the module whose job is to transmit.

## Project knowledge

Design decisions, session logs, bug records, and measured findings live in
`.claudevault/` — open that folder as an Obsidian vault.

**It is deliberately not tracked in git** (see `.gitignore`), so it exists only
on the machine it was written on. References to `.claudevault/...` elsewhere in
this README point at local files, not repository paths.
