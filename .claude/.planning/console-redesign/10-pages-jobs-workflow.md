# 10 — Pages: Jobs, Dead letter queue, Cron jobs, Workflows, Job flows

**Status:** done · **Depends on:** 06, 07, 08 · **Touches:** packages/panel/src/pages/control (Jobs, DeadLetter, Cron, Workflows, Flows and their parts), packages/panel/test, packages/panel/e2e

## Goal
The job and workflow pages use the new table, overlay and status primitives and match their boards.

## Steps
1. Read each board in full (Jobs, Job detail drawer, Dead letter queue, Cron, Workflows, Workflow detail, Job flows) and the sources.
2. Jobs: filter chips and tabs, table with status bars, selection and bulk bar, the detail drawer with timeline.
3. Dead letter queue: attempts list, requeue and discard confirmations on the shared confirm dialog.
4. Cron: list with next-run, create and edit modal, pause toggle.
5. Workflows and flows: run list, step timeline, gantt, the compensation views the design does not show (restyled only).
6. Flow actions keep going through `shared/flowOperationPolicy.ts` unchanged.
7. Update tests and e2e that assert old markup.

## Acceptance
- Every action each page had is still there, with the same permission and capability gating (existing tests pass, with
  string updates only).
- Destructive actions still ask first.
- `shared/flowOperationPolicy.ts` and `shared/actionGates.ts` are byte-for-byte unchanged (`git diff --stat` shows neither).
- Every status has a glyph and a word.

## Verify
```bash
bun test packages/panel && bun run typecheck && bun run lint && bun run format:check && git diff --stat -- packages/panel/shared
```

## Risks / notes
- Jobs is a long list. Windowing or paging stays as it is.

## Result

Jobs, the dead letter queue, Cron, Workflows and Job flows are on the new primitives. Same data, same actions, same routes.

**Changed**
- Jobs: `JobStateTabs` is a grid of state tiles (`aria-pressed`, count, glyph and word; a paused tile has no count), `JobsTable` is on the table recipe with `StatusBadge` and a failed row bar.
- Dead letter queue: `DlqProTable`, `DlqRow`, `DlqControl` and `DlqProControls` on the recipe and the shared form controls.
- Cron: `CronTable` on the recipe (delete column only when `canRemove`, delete button keeps its `Delete cron <name>` label), `CronForm` and its field parts on `Input`, `Select`, `Textarea`, `Banner` and text-safe state colours.
- Workflows: `ExecutionList`, `WorkflowFilters`, `WorkflowOverview`, `ExecutionDetail` (tabs with a 3px underline), `ExecutionSummary` and the step, payload, graph and compensation views; `ExecutionActions` and `ActionForms` on `Banner`, `Button` and `Textarea`.
- Job flows: `FlowList`, `FlowTree`, `FlowNodePanel`, `FlowSummary`, `FlowExplorer`, `FlowActionsBar` and `FlowSearch`. The local `STATE_STYLE` and `flowStateStyle` are gone: state is shown with `StatusBadge` and `StatusPill`.
- Primitives, fixed on the way: `Th` has a `right` prop (a `text-left` plus `text-right` pair only worked by CSS order, because `cn` does not merge; eleven `<Th className="text-right">` moved to `<Th right>`); `TableScroll` is `relative` so an absolutely positioned `sr-only` label cannot escape the scroller and widen the page (the DLQ page scrolled 164px sideways at 390 wide before); new `Textarea` in `ui/form.tsx`.
- Tests: new `test/page-tables-10.test.tsx` (5 tests: `Th` alignment, `JobStateTabs` pressed state, count and callback, a stuck `FlowList` row has the bad bar, a word, a glyph and "1 stuck", and `ExecutionList` shows the bad bar only for `compensation-stuck`). No existing test changed beyond string updates.

**Ran**
- `bun test packages/panel` from the repo root: 1474 pass / 0 fail.
- `bun run typecheck`, `bun run format:check`, `bun scripts/check-file-size.ts`, `bun run architecture`: clean. `bun run lint`: exit 0, warnings only; the ones in the files touched here (`set-state-in-effect` in `DlqControl`, `Cron`, `FlowTree`, `useWorkflowData`, `useJobMutations`) were there at HEAD.
- `git diff --stat -- packages/panel/shared`: empty, so `flowOperationPolicy.ts` and `actionGates.ts` are unchanged.
- Panel build: ok.
- Screenshots of Jobs, DLQ, Cron, Workflows, a workflow detail, Flows and a flow detail in `?demo`, both themes, 1440 and 390 wide, from `vite preview`: no horizontal scroll, no page errors.

**Not run**
- Playwright e2e and `axe`: the local Postgres on 55442 was down. Left for Phase 4.
- No screenshot diff against the boards; looked at by eye.

**Not built (R14, no data source or no layout data in the panel)**: Cron board's KPI tiles, "Last run" glyph column, Enabled switch, Run now and "Next five runs" timeline; Workflows board's KPI tiles, progress bars and the positioned DAG; Flows board's flow selector cards and Gantt timing. The existing page structures were kept and restyled.

**Changed behaviour to note**
- The Cron action error is `role="alert"` now (was `status`), because `Banner` maps a problem tone to `alert`.
- Flow and Workflow notices use `Banner`: an error is `alert`, ok and warn are `status`, as before.

**Kept**: page h1 texts ("Jobs", "Cron Manager", "Workflows", "Job Flows"), since tests and e2e find them by name.
