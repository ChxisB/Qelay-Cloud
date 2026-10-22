# 11 — Pages: Metrics, Workers, Logs, Alerts, Transport, Deployment

**Status:** done · **Depends on:** 06, 08 · **Touches:** packages/panel/src/pages/control (Metrics, Workers, Logs, Alerts, Transport, Deployment and their parts), packages/panel/test, packages/panel/e2e

## Goal
The monitoring pages use the new chart, log and table primitives and match their boards.

## Steps
1. Read each board in full and the sources.
2. Metrics: key figures, throughput and latency charts, per-queue bars, heat grid. Charts show only data the page loads.
3. Workers: table with heartbeat status and the detail card.
4. Logs: the always-dark viewer from task 08, with the page's existing filters and search.
5. Alerts: rule list, firing list, banner tones. The nav alert count (R7) reads the same store.
6. Transport and Deployment: the key-value and status cards, warnings as banners.
7. Update tests and e2e that assert old markup.

## Acceptance
- Same data, filters and actions as before (existing tests pass, with string updates only).
- No chart relies on colour alone, and each has an accessible name with its numbers.
- Transport and Deployment show nothing the Control API does not return (R6, R14).

## Verify
```bash
bun test packages/panel && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- Transport names appear as tags. The architecture rule bans broker names only in core, sdk, store-postgres, maintenance
  and control-api. The panel is outside it, but a tag label must come from the API's own transport name, not a hard-coded list.

## Result

Metrics, Workers, Logs, Alerts, Transport and Deployment are on the new primitives. Same data, same actions, same routes.

**Changed**
- Metrics: the throughput and queue-depth cards use `CardHeader sub` and the charts `Legend`; error rate is a standalone `Meter` (`role=meter`, "Success rate"); "Operation latency" and "Per-queue metrics" are on the table recipe (a slow p99 is warn-barred, a paused queue is an idle pill, a failed count is `text-danger`). `StatCard` "Total Completed" and "Push/sec" carry a spark from the series the page already holds.
- Workers: new `workers/WorkersTable.tsx` on the recipe (`Th right`, `aria-sort` on the two sortable columns, `StatusPill` active or stale, stale rows warn-barred). Quarantine and action messages are `Banner`s.
- Logs: new `logs/LogsEventList.tsx` and `logs/SelectedEvent.tsx`. Events are lines in the always-dark `LogBox` (search, status chips with counts, a "N matches" status, scroll area, foot). A line is a `role=button` inside `role=log`; selecting one opens the full record under the viewer. `LogLine` takes `ReactNode` for queue and job so search hits can be marked.
- Alerts: notice is a `Banner`; both tables are on the recipe; a firing row has the bad bar and a "Firing" pill; rules carry a "Browser" tag.
- Transport: transport name is a `Tag` (label is the API's own name; the colour follows a `gcp`/`aws` prefix, anything else is neutral); `QueueDoorbellTable` on the recipe with a verdict pill per row (Normal, Backlog, Paused, Unknown, Tick behind, Poison) and a bar for tick-behind (warn) and poison (bad); the dead-letter sample table on the recipe with the shared `Select`.
- Deployment: warnings keep `data-warning`, their role and the severity word, now as a tinted row with a `StatusPill`; "No warnings" is a polite `Banner`; Database, Tick and Doorbells states are pills; the Connections card has a `Meter` when both numbers are known (neutral tone, no invented threshold).
- Shared: `CardHeader` gained `sub`; `SortButton` is 44px tall.
- Tests: new `test/page-tables-11.test.tsx` (12 tests: worker status word, warn bar, `aria-sort` and right-aligned headers; `levelOf`, `markHits`, click and Enter select a log line, UTC time with ISO title, empty and foot text; per-queue pill and failed weight; doorbell verdict word and bar; warning order, pill word and roles). Existing tests changed in string or locator only: `e2e/monitoring.e2e.ts` and `e2e/walkthrough.e2e.ts` (log lines are `button`s in `log`, the search box is a `searchbox`).

**Ran**
- `bun test packages/panel` from the repo root: 1486 pass / 0 fail (the Transport and Deployment suites 22 + 115 pass alone).
- `bun run typecheck`, `bun run format:check`, `bun scripts/check-file-size.ts`, `bun run architecture`: clean. `bun run lint`: exit 0 (it flagged one `prefer-optional-chain` error in `LogsPro.tsx`, fixed); the warnings left are `set-state-in-effect` and `refs` patterns that were there at HEAD.
- `git diff --stat -- packages/panel/shared`: empty.
- Panel build ok. `?demo` screenshots of all six routes, both themes, 1440 and 390 wide, from `vite preview`: no horizontal scroll, no page errors. Preview stopped afterwards.

**Not run**
- Playwright e2e and axe: the local Postgres on 55442 was down. The Logs locator changes in `monitoring.e2e.ts` and `walkthrough.e2e.ts` are therefore unverified by a run. Left for Phase 4.
- No screenshot diff against the boards; looked at by eye. The demo had no firing alert, no Workers quarantine and no dead-letter samples, so those states were checked by tests only.

**Not built (R14, no data source)**
- Metrics: time-range selector, KPI deltas, failure-by-queue bars, time-in-queue and success/failure charts, per-queue push/pull/trend and failure-rate columns.
- Workers: filter chips, "Concurrency in use", transport tags, version text.
- Logs: events-a-minute histogram, level minimap, time-range control, Live tail and Wrap toggles, Download, worker and duration fields.
- Transport: KPI row, transport filter chips, doorbells-a-minute chart, per-transport capability cards, ordering column.
- Deployment: KPI row, node table, releases-running bars, connection pools by role, tick leader card, rollout history.

**Changed behaviour to note**
- Workers quarantine and action messages are `Banner`s: problem is `role="alert"`, ok is `role="status"`.
- Logs lines are `role=button` inside `role=log`, the search input is a `searchbox`, pagination is gone (the viewer scrolls over the 250-event buffer), times are UTC `HH:MM:SS` with the ISO stamp as the title.
- Alerts notice is a `Banner` (`role="status"`).
- The Transport and Deployment cross-links are default buttons (were ghost, which read as plain text).

**Kept**: every h1 ("Metrics", "Workers", "Activity Logs", "Alerts", "Transport", "Deployment"), the row and column labels the tests and e2e find by name, the copy of the Transport "How to read this" list.
