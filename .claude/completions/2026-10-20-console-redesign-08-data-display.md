# Console redesign 08: tables, charts, log viewer (2026-10-20)

Plan: `.claude/.planning/console-redesign/08-data-display.md`. Panel only; no route, API, auth or capability change.

## Changed
- `packages/panel/src/index.css`: `--log-*` tokens (once, not redefined for light) with `--color-log-*` mappings, and a `hatch-bad` utility.
- New `components/ui/Table.tsx` (row recipe), `components/ui/LogViewer.tsx`, and `components/ui/charts/` (`StackedBars`, `HBars`, `HeatGrid`, `Donut`, `Gantt`, `Legend`, `tones`).
- `components/ui/AreaChart.tsx`: a series can be `dashed`.
- Tests: new `table-recipe.test.tsx`, `charts.test.tsx`, `log-viewer.test.tsx` (42 tests). No existing test changed.

## Checked
Panel suite 1464 pass / 0 fail from the repo root; typecheck, lint (no errors), format:check, file-size and architecture clean; panel build ok.

## Owed or not run
No page uses these yet, so no screenshots and no Playwright e2e; they are checked as pages 09 to 13 adopt them.
Deviation R21 (real `<table>`, tokens instead of the log viewer's hex) is in `DESIGN-MAP.md`. The Logs page's search hit count and click-for-event behaviour belong to task 11.
