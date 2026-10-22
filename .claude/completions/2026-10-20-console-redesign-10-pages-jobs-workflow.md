# Console redesign 10: Jobs, DLQ, Cron, Workflows, Job flows

Date: 2026-10-20 · Plan: `.claude/.planning/console-redesign/10-pages-jobs-workflow.md`

## Changed (all under `packages/panel/`)
- `src/pages/control/jobsPro/*`, `DlqControl.tsx`, `dlq/*`: state tiles, table recipe, shared form controls.
- `src/pages/control/CronManager.tsx`, `cron/*`: table recipe, `Textarea`, `Banner`.
- `src/features/workflows/ui/*`: list, filters, overview, detail tabs, actions, forms.
- `src/features/flows/ui/*`, `domain/flowConstants.ts`: tree, list, panel, summary, actions; `STATE_STYLE` and `flowStateStyle` removed.
- `src/components/ui/Table.tsx`: `Th right`, `TableScroll relative`. `src/components/ui/form.tsx`: `Textarea`.
- Eleven `<Th className="text-right">` moved to `<Th right>` (DLQ, queue detail, queues, jobs, overview, cron).
- New `test/page-tables-10.test.tsx`.

## Checked
- `bun test packages/panel` (repo root): 1474 pass, 0 fail.
- `typecheck`, `format:check`, file size, `architecture`: clean. `lint`: exit 0, warnings in untouched-at-HEAD patterns only.
- `git diff --stat -- packages/panel/shared`: empty.
- Panel build ok; `?demo` screenshots in both themes at 1440 and 390: no horizontal scroll, no page errors.

## Owed or not run
- Playwright e2e and axe (local Postgres on 55442 was down): Phase 4.
- No screenshot diff against the boards.
- Not built, no data source: Cron KPI tiles, last-run column, enabled switch, run now, next-five-runs; Workflows KPI tiles, progress bars, positioned DAG; Flows selector cards and Gantt.
- Behaviour note: the Cron action error is `role="alert"` now (was `status`).
