# R12: the journal's commit lock (review F1)

Date: 2026-10-19. Tracker: `.claude/.planning/review-2026-10-19/CURRENT.md`.

## What changed

- `packages/store-postgres/test/journal.lockPasses.test.ts` (new): the commit sequence advances once per transaction.
- `docs/spikes/07-journal-order.md` (new): the cost, the three-step ladder, the horizon reader (designed, not built) and why.
- `docs/limits.md` (item 4) and `docs/known-issues.md` (row 7) point to it.

## Verify

- `bun test ./packages/store-postgres/test/journal.lockPasses.test.ts` 2 pass. No store code changed, so no `test:model`.

## Not done / owed

Step 3 (the horizon reader). Commit time on a managed instance (F17, D9).
