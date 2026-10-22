# Console redesign 04: status glyph, pills, tags, key figures (2026-10-20)

Plan: `.claude/.planning/console-redesign/04-status.md`. Panel only; no token, route or API change.

## Changed
- `packages/panel/src/components/ui/StatusBadge.tsx`: new `StatusGlyph`; `StatusBadge` is the design's pill (glyph, word,
  hairline); `StatusDot` tone `zinc` is `bg-idle`. `stateRole` and the `STATE_*` maps are unchanged.
- `packages/panel/src/components/ui/StatCard.tsx`: the key-figure tile, with an optional `spark` series.
- New `Spark.tsx` (path maths ported from the boards' `Q.spark`) and `Tag.tsx` (neutral, gcp, aws).
- Tests: `state-colours.test.tsx` and `ui-primitives.test.tsx` updated where they encoded the old dot and 32px figure; new
  `ui-status.test.tsx`.

## Checked
`bun test packages/panel` 1396 pass; typecheck, format:check, file-size check clean; lint warnings only in untouched files;
panel build ok; screenshots of `/?demo` and `/jobs?demo` in both themes read by eye.

## Owed or not run
`bun run architecture`, root `bun test` and Playwright e2e run in task 16. `Spark` and `Tag` have no page caller yet.
Deviation R15 (pill text and glyph keep the text-grade colour) is in `DESIGN-MAP.md`.
