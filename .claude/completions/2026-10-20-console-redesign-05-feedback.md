# Console redesign 05: feedback states (2026-10-20)

Plan: `.claude/.planning/console-redesign/05-feedback.md`. Panel only; no route, API or auth change.

## Changed
- `packages/panel/src/components/ui/feedback.tsx`: skeleton `LoadingState`, badge `EmptyState`, `ErrorState` with `Copy details`,
  live-strip `OfflineBanner`. Exports and props are unchanged (one optional `title` added).
- New `Banner.tsx`; `Toaster.tsx` re-skinned with per-level roles; `CopyButton.tsx` exports `copyText`.
- `src/index.css`: `--pop-shadow` per theme and `shadow-pop`.
- Tests: new `ui-feedback.test.tsx`; `design-tokens.test.ts` and `ui-primitives-guard.test.ts` updated.

## Checked
Typecheck, format:check, file-size check clean; lint warnings only in untouched files; panel build ok; the three affected test
files pass (127 tests); a screenshot of `/alerts?demo`. The full panel suite had 1 fail on the first run (radii guard), fixed.

## Owed or not run
Root `bun test`, `bun run architecture`, Playwright e2e run in task 16. No browser view of toast, error, loading or banner.
Deviation R16 (labels stay `Retry`) is in `DESIGN-MAP.md`. `flow-page-reads.test.tsx` fails alone, with or without this work.
