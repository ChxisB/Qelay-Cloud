# Event gateway and a smaller console (tasks 01 to 13 done)

Plan: `.claude/.planning/event-gateway/CURRENT.md`. Each task's Result has the detail; this is the hand-off view.
Inbound HTTP sources are a separate plan: `.claude/.planning/inbound-sources/CURRENT.md` (D12, **Proposed**, nothing built).

## Done

| Task | What |
|---|---|
| 01 | The 11 `*-classic` pages are deleted; their paths redirect (`LegacyRedirect`). |
| 02 | Add job, Bulk add and the Job inspector leave the sidebar and are reached from Jobs; Queue control is a queue's Settings tab; DLQ control was a copy of the DLQ page. `/queue-control` and `/dlq-control` redirect. |
| 03 | Health is one nav item with four tabs (Deployment, Diagnostics, Job delivery, Usage). |
| 04 | System is one nav item with six tabs (Server, Database, Backups, MCP, Benchmark, Fleet). |
| 05 | `NAV` is 14 items in four groups under Overview: Work, Automation, Monitor, System. |
| 06 | Flows is one nav item for job flows and workflow runs, with a switch between the two engines. |
| 07 | D11, the event-gateway model, is written in DESIGN.md and **Decided** by the owner on 2026-10-21. |
| 08 | Migration 16 (`destination`, `target` on `qcloud_webhooks`), the route types in core (`routeProblem`, chain cap 5) and the save-time loop check in the store (`409 route_cycle`, `409 route_chain_too_long` as store errors). 18 new store tests, a sender test, the regenerated schema snapshot. |
| 09 | The tick's sender delivers a `queue` route by adding a job with the id `qcloud-route-<deliveryId>` (core's `routeJobId`), no request made; the claim carries `destination` and `target`. 12 new tests; `test:model` 31 pass. |
| 10 | The Control API: `destination` and `target` on `/webhooks`, 409 `route_cycle` and `route_chain_too_long`, `GET /webhooks/deliveries` (events across routes), `GET /webhooks/stats`, `POST /webhooks/{id}/deliveries/retry` (bulk, at most 500), `routedJobId` on a delivery. Store paths for the feed, the retry and the stats (no migration). 17 new tests. **The new openapi routes need the owner's approval.** |

The nav went from 28 items in 6 sections to 14 items in 4 groups. No action was removed from any page (the parity
tables are in tasks 02 to 04). Every old URL still works: the tab pattern keeps each page on its own path, so there is no
`/health` or `/system` route and no redirect table beyond the 11 `-classic` paths and the 2 control paths.

## Done (continued)

| Task | What |
|---|---|
| 11 | The panel's Event gateway laid out like Hookdeck: Connections, Events (status chips, filters, sidebar, bulk retry), Metrics, a read-only Issues. |
| 12 | Docs: `docs/event-gateway.md` and the pointers to it; the review fixes below. |
| 13 | **Home**: Overview becomes the one screen with every metric and every error, each linking to its page. |

## Planned, not built

| Plan | What |
|---|---|
| D12 | Inbound HTTP sources: its own plan, nine tasks, seven human gates. Task 01 is the owner's sign-off on the design. |

## Review fixes (phase 4)

A queue route no longer gets a secret (store, tested); a Sending chip; Home polls the gateway stats once a minute; a plan row
for the all-routes feed with a time window; known-issues row 14 and the limits and upgrade notes. Disclosed, not fixed: the
unbounded backlog count in the stats read, the second route read in `GET /webhooks/deliveries`, no rate limit on read routes.

## Changed outside the panel

- `DESIGN.md`: D11 (Decided) and D12 (Proposed) in the decision table, an "Event gateway" and an "Inbound sources" note in
  section 6.
- `packages/panel/README.md`: a Navigation section.
- `docs/PORTING.md`: rows for the removed pages.
- `.claude/.planning/console-redesign/DESIGN-MAP.md`: one line pointing to the new nav.
- Task 08: `packages/core`, `packages/store-postgres` (migration 16, store, errors, tests, snapshot) and one test in
  `packages/maintenance`.

## Checked

- Task 08, 2026-10-21, local Postgres 18 (Homebrew, port 55442) with `QCLOUD_REQUIRE_DB=1`:
  `bun test packages/store-postgres packages/core packages/control-api packages/maintenance` gives 2953 pass, 23 skip, 0 fail.
  `typecheck`, `format:check` and `architecture` pass; `lint` has only the warnings that were there.
- Tasks 01 to 07 (no Postgres): `typecheck`, `lint`, `format:check`, `architecture` pass; `bun test packages/panel` 1562 pass,
  0 fail; `docs:check` passes.
- Whole-repo `bun test` has **1 fail**: `test/docs/release.test.ts` "package metadata". Eleven `packages/*/LICENSE` files still
  carry the "Copyright (c) 2024 Egeo Minotti" line that commit `4103cee` removed from the root `LICENSE`. It fails at `HEAD`
  too and nothing here touches a LICENSE; the owner decides which way to fix it (a memory note says to keep that line).

## Not run

- **Playwright e2e (axe included)** and the clip sweeps at 390 and 1440. The e2e files were edited in tasks 01 to 06 and
  type-check, but nothing executed them.
- The Docker, PgBouncer, TLS, Pub/Sub and ElasticMQ suites (23 skips in the run above).
- Docker-free only: `bun run test:model` passed for task 09 (31 tests); `read.plans.aux.test.ts` "throughput of the whole fourteen days" failed once in a rerun and passed twice (a planner flake on tables this plan does not touch; confirm at the gate).
- **Hookdeck's own dashboard.** Google refused the sign-in in the browser I launched, and I did not bypass it or attach to
  another project's browser without the owner's say-so. Task 11's screen map is from the public docs (events, connections,
  sources, requests, destinations, metrics, issues); screenshots or a browser the owner opens on the Hookdeck tab would
  tighten it.

## Decisions for the owner

1. **A workflow is a queue route, not a third destination kind** (decided with D11): a worker calls `startWorkflow`. No
   `wf:start` job was built.
2. **Loops are refused on save**, cycle check plus a longest chain of 5, with no run-time depth counter (decided with D11).
3. **D12, inbound sources:** sign off, or change, the design in DESIGN.md section 6 (task 01 of the inbound-sources plan).
4. Issues in the gateway is read-only (no acknowledge, resolve or ignore) unless the owner asks for stored state.
5. The LICENSE test failure above.

## Skipped on purpose

- The label renames in the plan (Dead letters, Schedules, Activity): page titles say Dead letter queue, Cron jobs and Logs.
- JavaScript transforms, delay, dedupe, replay of a request to another source, delivery groups.
- No commit, push or version bump.

- Task 10, 2026-10-21, local Postgres 18 with `QCLOUD_REQUIRE_DB=1`: `bun test packages/control-api test/docs packages/store-postgres/test/webhook` gives 809 pass and the LICENSE failure above (after `security:routes --write` regenerated `docs/security/routes.md`). `typecheck`, `format:check` and `architecture` pass.
- Task 11, 2026-10-21, no Docker: `bun run typecheck`, `format:check` and `architecture` pass; `lint` exits 0 (warnings only);
  `bun test packages/panel` gives 1596 pass, 0 fail. Playwright e2e and the clip sweeps were not run.
- Task 13, 2026-10-21, no Docker: `bun run typecheck`, `format:check` and `architecture` pass; `lint` exits 0 (warnings only);
  `bun test packages/panel` gives 1607 pass, 0 fail. Playwright e2e and the clip sweeps were not run. The `overview-render`
  DLQ-link assertion was scoped to the attention section because the new DLQ card is also a link to `/dlq`.
- Task 12 and the review, 2026-10-21, local Postgres 18 with `QCLOUD_REQUIRE_DB=1`: `typecheck`, `lint` (exit 0, warnings
  only), `format:check`, `architecture` and `docs:check` pass; `bun test` gives 5324 pass, 252 skip, 1 fail (the LICENSE
  test above, which fails at `HEAD`). `test:model` was not re-run after the review fixes.
