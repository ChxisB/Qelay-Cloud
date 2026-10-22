# Console redesign 11: Metrics, Workers, Logs, Alerts, Transport, Deployment

Date: 2026-10-20 · Plan: `.claude/.planning/console-redesign/11-pages-monitoring.md`

## Changed (all under `packages/panel/`)
- `src/pages/control/MetricsPro.tsx`, `metrics/*`: cards with subtitles, `Legend`, `Meter`, recipe tables, sparks on two tiles.
- `src/pages/control/WorkersPro.tsx`, `workers/WorkersTable.tsx` (new), `workers/SortButton.tsx`: recipe table, status pills, banners.
- `src/pages/control/LogsPro.tsx`, `logs/LogsEventList.tsx` (new), `logs/SelectedEvent.tsx` (new), `src/components/ui/LogViewer.tsx`: dark viewer with lines, chips and a selected-event card.
- `src/pages/Alerts.tsx`, `alerts/RuleForm.tsx`: banner, recipe tables, firing bar and word.
- `src/pages/control/Transport.tsx`, `transport/*`: tag, verdict pills and bars, recipe tables, shared `Select`.
- `src/pages/control/Deployment.tsx`, `deployment/*`: warning rows with pills, status pills, connections meter.
- `src/components/ui/Card.tsx`: `CardHeader sub`.
- `e2e/monitoring.e2e.ts`, `e2e/walkthrough.e2e.ts`: Logs locators (`log` > `button`, `searchbox`).
- New `test/page-tables-11.test.tsx`.

## Checked
- `bun test packages/panel` (repo root): 1486 pass, 0 fail.
- `typecheck`, `format:check`, file size, `architecture`: clean. `lint`: exit 0 (one `prefer-optional-chain` error in `LogsPro.tsx` fixed; the warnings left were at HEAD).
- `git diff --stat -- packages/panel/shared`: empty.
- Panel build ok; `?demo` screenshots of the six routes in both themes at 1440 and 390: no horizontal scroll, no page errors.

## Owed or not run
- Playwright e2e and axe (local Postgres on 55442 was down): Phase 4. The Logs locator edits are unverified by a run.
- No screenshot diff against the boards.
- Not built, no data source: see the task Result (time ranges, KPI deltas, histograms, minimap, node table, rollout history, per-transport cards).
- Behaviour notes: Workers messages and the Alerts notice are banners (`alert` or `status` roles); Logs pagination is gone and lines are buttons in a `log` region; Transport and Deployment cross-links are default buttons.
