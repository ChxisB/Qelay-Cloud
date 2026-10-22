# 10b — Jobs, the job inspector and their confirms

**Status:** done · **Depends on:** 03, 04b, 05 · **Touches:** packages/panel/src/pages/control (JobsPro, jobsPro/*, JobInspector, jobInspector/*, job/*), test, e2e
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, board "Work" (jobs part)

## Goal
Draw the job list and one job's history with the shared parts, and make the job actions ask in the page. DLQ and Bulk add moved to 10c.

## Steps
1. Read the board, `DESIGN-MAP.md` (deviations for "Work") and the files above with their tests.
2. `JobsPro`: rows with the stagger on first load, state as word and glyph; the status filter uses the shared highlight.
3. `job/JobTimeline.tsx`: the state history keeps its times and gets a drawn line with a glyph per entry that arrive in order.
   The board draws no job path in the inspector, so none is added (deviation c below).
4. Ask in the page with `confirmInPage`: `job/JobLogs.tsx` (clear logs) and Promote (bulk bar, row and the job's own page;
   `JobInspector.tsx` and `useJobMutations.ts` take an optional `confirm` and check their state again after the `await`).
   The board asks before Promote; the old page ran it with no question.
5. Edit the tests and e2e that stub the dialog or pin old markup in the same change.

## Acceptance
- Clear logs and Promote (bulk, row, job page) ask in the page, call the API on true and send nothing on false.
- No retry, remove, cancel, discard, purge, clean or drain control is drawn on a generic job surface.
- The rows of the first load arrive in order; a row a poll adds later does not; unchanged polls animate nothing.

## Verify
```bash
bun test packages/panel/test/job packages/panel/test/mutating-forms-fixes packages/panel/test/control-operation-hardening packages/panel/test/queue-settings-operations-hidden.test.tsx packages/panel/test/mutation-action-guards packages/panel/test/motion-guard.test.ts && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- This task passed 8 files, so DLQ and Bulk add became 10c.
- `window.confirm` was synchronous; check no caller relied on running code right after it returned.

## Result
Built and closed 2026-10-22.

**Changed (packages/panel):**
- `jobsPro/promoteConfirm.ts` (new): the Promote question for the bulk bar (`promoteConfirm(count)`) and for the job page (`PROMOTE_THIS_JOB`).
- `jobsPro/useJobMutations.ts`: `runOne` and `runBulk` take an optional `confirm` and ask before taking the action lease. `JobInspector.tsx`: `act` takes the same, and checks the job, busy flag and lookup again after the answer. `jobInspector/types.ts`, `job/JobActionsPanel.tsx`, `jobsPro/JobsTable.tsx` and `JobsPro.tsx` pass it through.
- `jobsPro/JobsTable.tsx`: shared `Table` parts, first-load stagger (`useFirstLoad`, `Tr arrive`), row actions named by the id tail (W6), select-all "on this page".
- `jobsPro/JobStateTabs.tsx`: counts through `Figure`. `jobsPro/JobsSelectionBar.tsx`: `role="group"`, `motion-drop`.
- `job/JobTimeline.tsx`: a drawn vertical line, a glyph per entry, entries arrive in order (W4).
- `job/JobLogs.tsx`: Clear logs asks with `confirmInPage` (danger); an `asking` ref stops a second click queuing the same question twice.

**Tests:** `jobs-motion.test.tsx` (new, 8). Ported, none loosened: `job-queue-pages-fixes-03/-04/-06`, `job-inspector-custom-state.part-05/-06` (the Promote and Clear logs clicks now answer the question with `answerConfirms()`, and part-05 asserts the question text), `jobs-render` and `viewer-gating` (new labels).

**Deviations (need the owner's word):**
1. Promote now asks first in the page; it ran with no question before (W2 lists it).
2. The timeline is vertical at all widths (the board is horizontal on wide screens, five events at most; the panel allows 20).
3. No job path or `ConnectionLine` in the inspector: the board draws none, so step 3's first plan was dropped.
4. Row action names use the id tail, not the whole id (W6).
5. New wording: "Promote N delayed jobs?", "Promote this job?" and their bodies.

**Ran (2026-10-22):** the Verify command (195 pass), `jobs-motion` (8 pass), typecheck, lint (only the warnings that were there), format:check, and the full panel suite from the repo root: 1988 pass, 0 fail, 270 files.
**Not run:** by eye in a browser (the timeline line and dots, the tab counts, the selection bar drop), e2e (no spec clicks Promote or Clear logs or reads the old row labels), the full repo gate and Docker-backed runs (task 15).
