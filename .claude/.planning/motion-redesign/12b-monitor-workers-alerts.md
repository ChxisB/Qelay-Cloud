# 12b — Monitor: Workers and Alerts

**Status:** done · **Depends on:** 03, 04b, 05 · **Touches:** packages/panel/src/pages (control/WorkersPro, control/workers/*, Alerts, alerts/*), test, e2e
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, board "Monitor" (Workers and Alerts frames; M3 to M6)

## Goal
Show each worker as a worker-to-queue line with a status word, make the alert rule switch say what it is, and move the two confirms into the page.

## Steps
1. Read the board, `DESIGN-MAP.md` ("Monitor", M3 to M6, M8) and `WorkersPro.tsx`, `workers/*`, `Alerts.tsx`, `alerts/*` with their tests.
2. Workers: a worker `ConnectionNode`, a `ConnectionLine` and the queue it serves where the panel already loads it; state is a glyph and a
   word. Rows arrive with the stagger on first load only.
3. Replace the `window.confirm` in `WorkersPro.tsx` (line 63, remove a worker record) and `Alerts.tsx` (line 221, delete an
   alert rule) with `confirmInPage`, same API calls. M3: the alert line is new wording (listed in DESIGN-MAP for the owner's
   word, approved 2026-10-22).
4. M4: the Unicode tick after "Removed stale registry record" becomes the check glyph.
5. M5: the rule switch shows "Enabled" or "Disabled" as a word and is named for its rule (`aria-label`).
6. M6: reword the one banner sentence as the board has it. The panel's `brand-copy-guard` must still pass; say Qelay, not
   bunqueue, and keep the "no alerting backend" claim true.
7. Edit the tests and e2e that stub the dialog or pin old markup in the same change.

## Acceptance
- Both confirms ask in the page, call the same API on true and nothing on false.
- The rule switch has a word and an accessible name that includes the rule name.
- A worker whose queue is not known draws no line and still shows its row.
- A poll that changes nothing animates nothing.

## Verify
```bash
bun test packages/panel/test/alert packages/panel/test/mutation-action-guards packages/panel/test/control-operation-hardening packages/panel/test/brand-copy-guard.test.ts packages/panel/test/motion-guard.test.ts && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- `Alerts.tsx` is near the 300-line cap; if the line pushes it over, move the row into `alerts/`.
- Name the tests that stubbed `window.confirm` in the Result.

## Result
**Built 2026-10-22.**

Changed (under `packages/panel`):
- `src/lib/useLeavers.ts`: a root-cause fix found while porting Workers. The hook kept the old order, so a table sorted again by the user would have shown the old order until its leavers went. It now keeps the NEW order of the items and puts each leaver back in the slot it had. Callers: `Toaster`, `AttentionList`, `CronTable`, and now `WorkersTable` and `AlertTables`. The toast case is still covered by `overlay-motion`.
- `src/pages/control/workers/WorkersTable.tsx`: rows come from `useLeavers` and `useFirstLoad` (first load rises in a stagger, a removed row leaves for 180 ms and is `inert`); Active, Processed and Failed are `Figure`s that wash only on a real change. Same columns, same remove button rules, same exports.
- `src/pages/control/WorkersPro.tsx`: `workers` and `rows` are memoized (the leaver hook needs a stable list). Removing a record asks in the page first (`confirmInPage`, label "Remove record", danger), then runs the unchanged guarded DELETE. The message after it has the check glyph, not the Unicode tick (M4). Stale and Quarantined carry a glyph and a word (M2, moved here from 12a).
- `src/pages/alerts/AlertTables.tsx` (new, 142 lines): `FiringTable` and `RulesTable`, split out so `Alerts.tsx` stays under the cap. Firing rows rise in and leave when the breach clears; the rule switch shows the word Enabled or Disabled and is named `Disable rule X` / `Enable rule X` (M5); each table hands back its `empty` slot when nothing is shown, so the last leaving row still animates.
- `src/pages/Alerts.tsx`: delete asks in the page (`Delete alert rule "X"?`, label "Delete rule", danger) and then removes the rule; a status line says what happened; the banner sentence is the board's (M6).
- `test/server-action-pages-02.test.tsx`: the lock test now waits one beat for the in-page answer before it resolves the DELETE. The text it asserts is unchanged.
- `e2e/monitoring.e2e.ts`: the alert delete answers the in-page question with `answerQuestion`. Edited, not executed (task 15).

Tests (none loosened): new `test/alerts-workers-motion.test.tsx` (9). Workers: the question, the label and `danger` are asked; no sends nothing; yes sends one DELETE, the message has the check icon and no tick, the row gets `motion-leave` and `inert` and is gone after its leave; Stale and Quarantined say it in a word and a glyph, and a calm registry shows neither. Table: first load rises in order, a poll with equal content keeps the same `tr` elements and washes nothing, one moved count washes once; a worker with no queues still has its row with a dash; a re-sorted list follows its new order and a removed row keeps its slot while it leaves. Alerts: the switch word and name, and the flip writes its status line; delete asks, no keeps the rule, yes removes it, the row leaves and the sentence is said; a firing row rises, the same result again changes nothing, and the last one leaving is held for its leave before the all-clear shows; the banner says Qelay and names no hosted product.

The tests that stubbed the dialog and were ported: the Workers lock test in `server-action-pages-02.test.tsx` and the Alerts delete step in `e2e/monitoring.e2e.ts`. The other files that still stub `window.confirm` (`control-pages-stable-fixes*`, `control-operation-hardening`, `backup-operation-ownership`, `frontend-blockers-hardening.part-02`, `mutation-action-guards.part-02`) belong to later tasks and pass unchanged. `server-action-pages.helpers.tsx` still sets `window.confirm = () => true` as a leftover; task 14 removes it with the guard.

Ran, from the repo root: the Verify (`test/alert*`, `mutation-action-guards*`, `control-operation-hardening*`, `brand-copy-guard`, `motion-guard`) plus the new test, `page-tables-11`, `server-action-pages*`, `pro-pages-failure`, `async-ui-state-fixes`, `overlay-motion`, `state-colours` and `control-pages-stable-fixes*`: 197 pass, 0 fail, 42 files. `bun run typecheck` (root, tooling, and the panel's src, node and e2e projects), `bun run lint` (exit 0; the one warning in `WorkersPro.tsx`, the `setState` in the scope effect, was there before), `bun run format:check`. Full panel suite: 2028 pass, 0 fail, 275 files.

Deviations from the plan:
- No worker node and no worker-to-queue line (plan step 2). The board shows Queues as a text column, so the column stays; a worker whose queue is not known shows a dash and its row, which is the Acceptance line.
- "Worker removed" does not leave on a timer: raw durations are forbidden in TS, and the message stays until the next action.
- When the last worker is removed, the table gives way to the EmptyState without a leave animation (Workers only; Alerts handles it through its `empty` slot).
- The `useLeavers` order change above.

Needs the owner's word: the alert-delete detail line, "Remove record", "Delete rule", the M6 banner sentence, and the status notes ("Rule "X" is disabled.", "Deleted rule "X".", "Saved rule "X". It is checked straight away.", plus " Its triggered row leaves." from the board).

Not run: e2e (including the edited monitoring step), the panel by eye at 1280 px and 390 px, the accessibility scan. The `motion-leave` and `inert` transform on a table row is unseen in a browser.
