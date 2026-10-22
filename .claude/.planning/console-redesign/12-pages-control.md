# 12 — Pages: Server, Add job, Bulk add, Job inspector, Queue control, DLQ control, Webhooks, Diagnostics, Benchmark

**Status:** done · **Depends on:** 06, 07 · **Touches:** packages/panel/src/pages/control (Server, AddJob, BulkAdd, JobInspector, QueueControl, DlqControl, Webhooks, Diagnostics, Benchmark and their parts), packages/panel/test, packages/panel/e2e

## Goal
The control pages use the new form, banner and overlay primitives and match their boards.

## Steps
1. Read each board in full (AddJob and BulkAdd already read) and the sources.
2. Add job and Bulk add: the `.field` form layout, JSON editor as `.code`, validation messages as the field error state,
   a result banner, the typed confirmation where the page had it.
3. Job inspector, Queue control, DLQ control: lookup card, state card, action row on the shared confirm dialog.
4. Webhooks: list and create modal, secret shown once as it is now (`.mask` styling only).
5. Server, Diagnostics, Benchmark: cards, kv lists, run controls (restyled, behaviour unchanged).
6. Update tests and e2e that assert old markup.

## Acceptance
- Same fields, validation, request bodies and capability gating as before (existing tests pass, with string updates only).
- A webhook secret is never rendered after the one-time view, and never appears in a log or in test output.
- Every form control has a label and an associated error message when invalid.

## Verify
```bash
bun test packages/panel && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- Viewer-role users see read-only forms today. The new disabled style must still read as disabled at the contrast rules.

## Result

Server, Add job, Bulk add, Job inspector, Queue control, DLQ control, Webhooks, Diagnostics and Benchmark are on the new form, banner, table, chip and log primitives. Same fields, validation, request bodies, routes and capability gating.

**Changed**
- Result and error messages are `Banner`s: Add job, Bulk add, Job inspector (`state.msg`), Queue control (`msg`), Webhooks (`actErr`), Benchmark (`live.error`), Server (`actionError`, and the stale-agent notice as a warn banner). A failure is `role="alert"`, a success `role="status"`.
- Webhooks: the table is on the recipe (`Th right`, sr-only "Deliveries" and "Remove" headers); event chips and delivery filters are `Button` chips with `aria-pressed` inside a named group; the secret is shown once as before; the form error is `role="alert"`.
- Diagnostics: 13px muted text, "Top object types" on the recipe with visible column headers, a bordered Prometheus URL box.
- Benchmark: preset `Button` chips in a group, the primitive `Legend`, `RunHistory` on the recipe, the clean result is `role` alert or status.
- Server: `StatusPill`, a bordered launch-command box, `CodeBlock` for the agent start command, `ProcessLogs` as a light card header over a dark `LogScroll` (region "Process output"; stderr lines say "ERROR"), config footer messages (`Saved` status, error alert), `EnvVarsEditor` (44px `IconButton` remove with its `aria-label`, preset `Button` chips), `StoragePanel` and `AgentInfoCard` type and box restyle. `ConfigCard` needed no change. The status-bar brand gradient stays (`server-render.test.tsx` asserts it).
- Job inspector and Job logs: log lines are a named, focusable scroll region; children Show/Hide has `aria-expanded` and an alert on error; `aria-invalid` and `aria-describedby` on the data editor and the action number fields. Queue control and DLQ control: same on Promote N, Clean, Rate limit and Concurrency.
- Bulk add: the file input is keyboard-reachable (`sr-only`).
- Ghost buttons that read as plain text became default buttons (Job logs Refresh, children toggle, Newer/Older, Benchmark Clean queue / Export JSON / Clear, Reload latest, Add variable).
- `CodeBlock` and the Job log region carry a scoped `oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex`: a scroll area has to be a tab stop.
- Tests: new `test/page-forms-12.test.tsx` (8 tests: `CodeBlock` region, name, tab stop and tone; env remove button name and size; preset chip adds a row and leaves the list; config footer alert and status; unhealthy disk announced; webhook event chips group and `aria-pressed`; webhook form error alert). Earlier segments updated string assertions only where markup moved.

**Ran**
- `bun test packages/panel` from the repo root: 1494 pass / 0 fail.
- `bun run typecheck`, `bun run format:check`, `bun scripts/check-file-size.ts`, `bun run architecture`: clean. `bun run lint`: exit 0 (two `no-noninteractive-tabindex` errors fixed with the scoped disable above; the warnings left are `set-state-in-effect` and `refs` patterns that were there at HEAD).
- `git diff --stat -- packages/panel/shared`: empty.
- Panel build ok. `?demo` screenshots of nine routes (server, webhooks, diagnostics, benchmark, job, add job, queue control, DLQ control, bulk add), both themes, 1440 and 390 wide, from `vite preview`: no horizontal scroll, no page errors. Server (dark, 1440) and Webhooks (light, 390) were looked at by eye. Preview stopped afterwards.

**Not run**
- Playwright e2e and axe: the local Postgres on 55442 was down. Left for Phase 4.
- No screenshot diff against the boards. States the demo does not show (webhook secret view, bulk results, errors) are covered by unit tests only.

**Not built (R14, no data source or new behaviour)**
- Add job: request-preview card, queue select, "Role needed" row. Bulk add: parsed-rows table, validity legend, progress bar, batch-size select, drop zone.
- Job inspector: recent lookups, attempts table, "Last error attempt" pill, "Search activity logs" link.
- Queue control: chips, Discard/Save, Pending-changes and Right-now cards. DLQ control: Filter, Matches, Act, Preview, Recent-bulk-actions cards.
- Diagnostics: six-checks table, KPI sparks, "Copy report", "Run checks again". Server: "Who controls the process" mode picker, process KPIs, "Open deployment" link.

**Changed behaviour to note**
- Banner roles: Webhooks `actErr`, Server `actionError` and the Job inspector failure were `status` and are now `alert`; the Benchmark error was a plain div and is now `alert`. The Server stale-agent message is a warn banner with a title and the sentence "Showing the last known state. ...".
- "Process output" is `role="region"`, not `role="log"`.

**Kept**: the webhook one-time secret view, all route and Control API behaviour, the e2e hooks (`Show deliveries`, `Retry delivery <id>`, `webhook-url`, `webhook-secret`, `Generate a signing secret`, `No deliveries`, `No output yet.`, `logs unavailable`).
