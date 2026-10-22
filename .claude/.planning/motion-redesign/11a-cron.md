# 11a — Cron

**Status:** done · **Depends on:** 03, 04b, 05 · **Touches:** packages/panel/src/pages/control (CronManager, cron/*), test, e2e
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, board "Automation" (cron part)

## Goal
Show each schedule as a clock-to-queue line with its next run, and move its two confirms into the page.

## Steps
1. Read the board, `DESIGN-MAP.md` (deviations for "Automation") and `CronManager.tsx`, `cron/*` with their tests.
2. Each schedule: a schedule `ConnectionNode`, a `ConnectionLine` and the target queue `ConnectionNode`; the next-run time keeps its
   words. Rows arrive with the stagger on first load.
3. `CronForm` opens with `usePresence`; the cron expression helper keeps its text preview.
4. Replace the `window.confirm` in `CronManager.tsx` (line 50) and `cron/CronForm.tsx` (line 89) with `confirmInPage`, same
   text and API.
5. Edit the tests and e2e that stub the dialog or pin old markup in the same change.

## Acceptance
- List, create, edit, pause and delete behave as today, apart from the in-page confirm.
- Both confirms call the same API on true and nothing on false.
- The next-run time is text, not only a drawn line.

## Verify
```bash
bun test packages/panel/test/cron packages/panel/test/motion-guard.test.ts && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- A schedule with an invalid expression draws no line and says why in words.

## Result

**Built 2026-10-22.**

Changed (under `packages/panel`):
- `src/pages/control/CronManager.tsx`: Delete asks in the page first (`Delete cron "<name>"?`, button "Delete cron", danger, with the old sentence as detail), then takes the action lease and sends the DELETE as before. A cancel sends nothing.
- `src/pages/control/cron/CronForm.tsx`: Create asks in the page after the name check (`Create the schedule "<name>"?`, button "Create schedule"; the detail keeps the same-name overwrite warning), then `beginCreate` and the POST as before. The "Schedule created ✓" text is now a check glyph and the words, with `motion-pop`.
- `src/pages/control/cron/CronTable.tsx` (rewritten, 134 lines): rows of the first load rise in a stagger (`useFirstLoad`, `Tr arrive`); a deleted row stays 180 ms as `motion-leave` and `inert` (`useLeavers`, list memoized); the Queue cell draws a short `ConnectionLine` that sends one comet each time the run count goes up (`useRises`); Runs is a `Figure`. Next Run stays text.
- `src/pages/control/cron/CronWire.tsx` (new, 61 lines) and `CronPrimaryFields.tsx`: a "What this will do" group (schedule node, line, queue node, and the sentence `Adds a "<job>" job to the queue each time the schedule fires.`), and Next runs shown as three chips. The line is drawn only when the schedule parses and a queue is named; an invalid expression draws none and the note above still says why in words.
- `e2e/fixtures.ts`: `answerQuestion(page, question, 'accept' | 'dismiss', confirmLabel)`. `e2e/dashboard.e2e.ts` and `e2e/walkthrough.e2e.ts` use it for the cron create and delete instead of the browser dialog.

Tests (none loosened):
- New `test/cron-motion.test.tsx` (7): first-load row stagger and none for a polled-in row; a poll that changes nothing washes no count, a rising count sends one comet; Next Run stays text; Delete asks, a cancel sends no DELETE, a yes sends it and the row leaves (`motion-leave`, `inert`, then gone); Create asks and a cancel sends no POST; the wire shows the schedule, queue and sentence, with chips; an expression that does not parse draws no line and the note says why.
- Ported to `answerConfirms()`: `cron-add-clone-audit.helpers.ts` (used by `cron-add-clone-audit`, `-02`, `-03`) and `mutation-action-guards.test.tsx` (the Cron mutex test now waits for the question: `settle(5)` after the double click, still exactly one DELETE).

Ran: the cron-related tests, `motion-guard`, `mutation-action-guards*` (74 pass, 0 fail, 14 files); `bun run typecheck` in the panel (src, node and e2e projects); `bun run lint` (exit 0); `bun run format:check`. Full panel suite from the repo root: 2000 pass, 0 fail, 272 files.

Deviations from the plan:
- The plan said a schedule node, line and queue node per row. The board draws a short line in the Queue cell, so the table does that; a full node pair per row would double the row height. The full pair is in the form's wire.
- "CronForm opens with `usePresence`": `CreateCard` shows its children when `open || empty` and has no exit, so the form is unchanged here. Not added, to keep the card's behaviour.
- The page has no edit or pause (an existing name is refused, a replace is a delete then a create). Nothing was added for them.
- A second click on Delete while its question is open can queue a second question; the lease still lets one DELETE through. In practice the scrim covers the page.

Needs the owner's word (A2): the "What this will do" group, its placeholders "not set yet" and "choose a queue" (both from the board) and its sentence, and the Next runs chips.

Not run: the full repo gate (`architecture`, other packages), Postgres-backed tests, the e2e (including the ported cron steps, which were edited but never executed), `dev:stub` by eye at 1280 px and 390 px, the accessibility scan. The motion is unit-tested only: the Queue-cell line (with its 16 px overshoot), the wire grid and the leaving `<tr>` transform are unseen in a browser.
