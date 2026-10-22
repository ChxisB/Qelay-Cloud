# Console redesign 12: Server, Add job, Bulk add, Job inspector, Queue control, DLQ control, Webhooks, Diagnostics, Benchmark

Date: 2026-10-20 · Plan: `.claude/.planning/console-redesign/12-pages-control.md`

## Changed (all under `packages/panel/`)
- `src/pages/control/AddJob.tsx`, `BulkAddJobs.tsx` and parts: form layout on the shared primitives, result `Banner`s, `sr-only` file input.
- `src/pages/control/JobInspector.tsx`, `jobInspector/*`, `job/*`: lookup and state cards, action `Banner`, named log region, `aria-invalid`/`aria-describedby` wiring.
- `src/pages/control/QueueControl.tsx`, `queue/*`, `DlqControl.tsx`, `src/features/queue-operations/ui/*`: field errors wired, banners, default buttons.
- `src/pages/control/Webhooks.tsx`, `webhooks/*`: recipe table, event and filter chips, alert on error.
- `src/pages/control/Diagnostics.tsx`, `diagnostics/*`, `Benchmark.tsx`, `benchmark/*`: restyle, recipe tables, `Legend`, preset chips.
- `src/pages/control/ServerControl.tsx`, `server/*` (`StatusConsole`, `StatusFacts`, `ProcessLogs`, `ConfigActions`, `AgentInfoCard`, `EnvVarsEditor`, `StoragePanel`): banners, `CodeBlock`, dark log body, 44px remove button, chips.
- `src/components/ui/CodeBlock.tsx`: scoped lint disable for the scroll-area tab stop.
- New `test/page-forms-12.test.tsx`.

## Checked
- `bun test packages/panel` (repo root): 1494 pass, 0 fail.
- `typecheck`, `format:check`, file size, `architecture`: clean. `lint`: exit 0 (two `no-noninteractive-tabindex` errors fixed; the warnings left were at HEAD).
- `git diff --stat -- packages/panel/shared`: empty.
- Panel build ok; `?demo` screenshots of nine routes in both themes at 1440 and 390: no horizontal scroll, no page errors.

## Owed or not run
- Playwright e2e and axe (local Postgres on 55442 was down): Phase 4.
- No screenshot diff against the boards.
- Not built, no data source: see the task Result (request preview, parsed rows table, recent lookups, attempts table, queue-control and DLQ-control cards, six-checks table, process-mode picker).
- Behaviour notes: several messages are now `alert` banners (Webhooks, Server, Job inspector, Benchmark); "Process output" is a `region`, not a `log`.
