# 10c — DLQ and Bulk add

**Status:** done · **Depends on:** 10b · **Touches:** packages/panel/src/pages/control (DlqPro, dlq/*, BulkAddJobs, bulkAdd/*, AddJob), test, e2e
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, board "Work" (DLQ part)

## Goal
Draw the dead-letter list with the shared parts, and move the Bulk add "replace input" confirm into the page.

## Steps
1. Read the board (`Work`, DLQ part), `DESIGN-MAP.md` (deviations for "Work") and the files above with their tests.
   `DlqPro.tsx` is 298 lines: any addition goes into `dlq/*`, not into the page file.
2. `DlqPro`: the summary tiles (`StatCard`, counts through `Figure`), a "DLQ by queue" pill group (`aria-pressed`), rows with the
   first-load stagger (`useFirstLoad`, `Tr arrive`), the error clamp toggle per row (`aria-expanded`). Retry and purge are not
   drawn (DESIGN-MAP W5, and the Acceptance below): the gated note with "Why?" stays, and the disabled "Retry unavailable" button
   and the Actions column go.
3. `bulkAdd/useBulkFileInput.ts`: replace `window.confirm` with `confirmInPage` (`Replace the current input with "<file>"?`,
   asked only when the input is not empty). After the `await`, check `generationRef`/`readerRef` again. A cancel keeps the input.
4. `/add-job` and `/jobs/bulk-add` have no board: they take the shared field error, press and toast behaviour only.
5. Edit the tests and e2e that stub the dialog or pin old markup in the same change.

## Acceptance
- The replace question asks in the page, reads the file on yes, and on no leaves the input and the file picker as they were.
- No retry, remove, cancel, discard, purge, clean or drain control is drawn on the DLQ page.
- The DLQ rows of the first load arrive in order; a row a poll adds later does not; an unchanged poll animates nothing.
- Every file stays at or under 300 lines.

## Verify
```bash
bun test $(grep -rlE "DlqPro|BulkAddJobs|useBulkFileInput|AddJob" packages/panel/test) packages/panel/test/motion-guard.test.ts && bun run typecheck && bun run lint && bun run format:check
```
(The tests are found by content: no file has "dlq" or "bulk" in its name.)

## Risks / notes
- `window.confirm` was synchronous: `useBulkFileInput` reads the file right after the answer, so a second pick during the question must not run twice.
- Two live `answerConfirms()` conflict: stop one before starting another in a test.

## Result

**Built 2026-10-22.**

Changed (under `packages/panel`):
- `src/pages/control/dlq/DlqProControls.tsx`: Retry all, Purge all, Retry this queue and Purge this queue are gone. "DLQ by queue" is a `role="group"` of queue pills (`aria-pressed` on the chosen one, counts through `Figure`) under a `CardHeader` that says "Pick a queue to see only its jobs."
- `src/pages/control/dlq/DlqProTable.tsx`: no Actions column and no "Retry unavailable" button; rows of the first load rise in a stagger (`useFirstLoad`, `Tr arrive`); the error clamp toggle is unchanged. `DlqPro.tsx` is untouched (298 lines).
- `src/lib/capabilities/useCapabilities.ts`: `useDlqMutations` deleted (no caller was left).
- `src/pages/control/bulkAdd/useBulkFileInput.ts`: `onFile` is async and asks with `confirmInPage` (`Replace the current input with "<file>"?`, button "Replace") only when the input is not empty. After the answer it returns on a cancel, or when a newer pick or an unmount took the generation.
- Summary tiles: unchanged, `StatCard` already washes a changed string or number on its own.

Tests (none loosened):
- New `test/dlq-motion.test.tsx` (6): first-load row stagger and no stagger for a polled-in row; pills with `aria-pressed` that move on a click; no Retry or Purge button while "Why?" stays; Bulk add takes a file without asking when the box is empty; asks when it holds text, a cancel keeps it, a yes reads the file.
- Ported: `server-action-pages.test.tsx` and `server-action-pages-02.test.tsx` (asserted the disabled buttons, now assert none are drawn and no request is sent), `viewer-gating.test.tsx` (DLQ describe: no bulk button for operator, viewer, or where retry exists), `frontend-blockers-hardening.part-03.test.tsx` (the `window.confirm` stub became `answerConfirms()` and the test checks the question), `e2e/monitoring.e2e.ts` (zero Retry/Purge buttons; not run).

Ran, against this checkout, no Postgres or Docker:
- 10c Verify: 111 pass, 0 fail, 21 files (the DLQ, Bulk add and AddJob tests and `motion-guard`).
- `bun run typecheck`, `bun run lint` (0 errors, pre-existing warnings), `bun run format:check`: clean.
- Full panel suite from the repo root: 1993 pass, 0 fail, 271 files.

Not run: `e2e/monitoring.e2e.ts` (needs a browser and Postgres), the full repo gate, the page by eye. The pills' layout, the first-load rise and the count wash are unit-tested only.

Deviations (also in DESIGN-MAP, "W5 outcome"): the retry and purge controls are removed, not disabled (W5; the plan's step 2 said the disabled "Retry unavailable" button stays, which contradicted its own Acceptance, so the step is corrected); the id column keeps the full id as one link (the board splits it and adds the queue name, which would repeat on a one-queue page).

Limit: a second file pick while the first question is open queues a second question rather than replacing the first (the page's confirm queues, it never stacks); on a yes to both the later pick wins, because the earlier pick no longer owns the generation.
