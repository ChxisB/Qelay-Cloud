# 51 — Flows: Control API and panel

**Status:** done · **Depends on:** 50, 34 · **Phase:** 4

## Goal

Make flows visible and operable in the panel: browse a flow's tree, see each node's state, and act on failed or stuck nodes safely.

## Scope

In: Control API flow endpoints, the capability flag, the panel's Flows page and the inspector's parent/children links.
Out: workflows (62), flow creation UI beyond what the panel already has for Add Job (add it only if the panel already offers it).

## Reference

Panel: `src/pages/control/Flows*`, `src/features/flows`, `agent/flow`; its API calls in `src/lib/bq/` for flows.

## Steps

1. **Endpoints:** `GET /flows` (roots, paginated, with state summary), `GET /flows/:id` (the tree: parent, children and their states, failures, depth, with a node cap and a `truncated` marker for huge flows), `POST /flows/:id/actions` for supported operations: retry failed children, remove a flow (confirmation required), promote a stuck parent. Use the panel's existing paths and shapes where they exist.
2. **Fencing and safety:** actions carry `expectedVersion`s for the nodes they touch and run in one transaction; a partial application is never visible. Destructive actions need the confirmation field and the `operator` role, and are audited (task 32).
3. **Capability:** `features.flows` true when the store supports flows; the panel's navigation uses it (task 34).
4. **Panel:** Flows page works against the new endpoints (tree view, node state colours, failures, links to the job inspector); the Job Inspector shows "parent of" and "child of" links. Remove any dependency on the Qelay-server-only flow agent code.
5. **Large flows:** virtualised or lazy tree rendering for flows with thousands of nodes; a visible truncation notice.
6. **Tests:** API contract tests; behaviour tests for each action including a stale-version rejection; panel component tests for the tree and for the truncated state; an e2e: create a flow, fail a child, retry it, watch the parent complete.

## Acceptance

- The e2e flow passes: create, fail, retry, parent completes.
- A removal of a flow either removes all of its jobs or none (kill-the-connection test mid-action).
- A flow with 5,000 nodes renders without freezing and with a truncation notice where applicable.
- Every flow mutation produces an audit row.

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/control-api packages/panel --grep flow
bun run test:e2e --grep flow
```

## Risks / notes

- Flow actions on a parent whose children are `active` are the risky ones. Define and test each outcome before exposing the button.
- Keep tree reads bounded; an unbounded recursive query on a pathological flow is a denial-of-service vector.

## Result

**Done locally. Nothing was applied and no real cloud was contacted.** Flows are listed, read and operated through the Control API, and the
panel is a client of it. Every Acceptance line is true; what ran is under "Run" and what did not under "Not run". Design decisions are in
the task 51 amendment to [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md).

**Built**

- **Store** (`packages/store-postgres`): migration 7 `'flow membership'` adds nullable `flow_root` and `flow_depth` to `qcloud_jobs`
  (both null or both set), with `qcloud_jobs_flow_idx` and `qcloud_jobs_flow_roots_idx`. `flows.roots`, `flows.view` and `flows.childIds`
  are bounded reads (`flowView.ts`, SQL in `flowViewSql.ts`). `flows.act` runs `retry-failed`, `promote` and `remove`, one transaction
  each, fenced by the versions the caller read (`flowActions.ts`, `flowRetry.ts`, `flowPromote.ts`, `flowRemove.ts`). `addFlow` tags
  every job and detaches the orphans an earlier flow of the same ids left (`tagFlow`).
- **Control API:** `GET /flows`, `GET /flows/:id`, `POST /flows/:id/actions` (`routes/flows.ts`, `jobs/flowModel.ts`). Actions need the
  `operator` role, `remove` needs the root id as `confirm`, and each call is one audit row. Job reads carry `parentId`, `flowRoot` and,
  on a single-job read, `childrenIds`; `/jobs/:id/children` returns real values. `features.flows` is true where the jobs routes are
  served. `docs/openapi.yaml` lists the three routes and a test keeps it equal to what is served.
- **Panel:** a Control-API-only Flows page (`features/flows`: list with paging, find-by-job, a windowed tree with keyboard use, the
  selected job's panel, Retry, Release and Remove, the truncation notice and Show more), the Job Inspector's "This flow", "Parent of"
  and "Child of" links, and demo-mode replies for the three routes. The agent-based create form, per-job methods, DAG canvas and recents
  are gone.
- **Docs:** `docs/compat.md` (the flow actions and the operator rows), `docs/limits.md` (two rows), `DESIGN.md`, `docs/PORTING.md`
  (the "Flows (task 51)" section), the spike amendment.

**Acceptance**

- *The e2e passes (create, fail, retry, parent completes):* `packages/panel/e2e/flows.e2e.ts`, three tests (an operator retries the
  failed child and the parent completes; a viewer sees no action and the server refuses a forced one; a link from a job opens the flow
  at that job and a stale root is explained), on Chromium and WebKit against the built panel and the Postgres-backed runtime.
- *A removal removes all of a flow's jobs or none:* `flow.act.atomic` ends the connection in the middle of a removal and finds every job
  in place; `flow.act.race` removes while a worker finishes a child and finds the flow gone or whole; `flows.actions` refuses a flow
  with a running job whole.
- *5,000 nodes render without freezing, with a notice:* the tree draws a window (at most 30 of 5,000 lines in the document; the scroll
  area is the full 200,000 px), a 5,000-job page opens inside the 5 s the test allows, and a view cut at the limit says "Showing
  N of M jobs", offers Show more up to 5,000, and says it is limited beyond that.
- *Every flow mutation is audited:* `flows.actions` asserts one finished audit entry per call (action `POST /flows/:id/actions`, target
  `id=<root> flowAction=<name>`) for a success (200), a refusal (409) and a rejected body (400), and a viewer's refused call (403) is
  audited too.

**Run** (PG 18.6, Pub/Sub emulator, ElasticMQ 1.7.1)

- `bun run typecheck`, `bun run lint` (exit 0; the `react/set-state-in-effect` warnings are the repo's configured `warn` level and appear
  across the panel), `bun run format:check` and `bun run architecture` are clean.
- `bun test` with `QCLOUD_REQUIRE_DB=1`, `QCLOUD_REQUIRE_PUBSUB=1` and `QCLOUD_REQUIRE_SQS=1`: 4,193 pass, 29 skip (the PgBouncer and TLS
  suites, which need Docker), 1 todo, 0 fail; 4,223 tests in 432 files, 899.71 s.
- The first full run failed twice, both on timeouts: the `connection.fault` hook (56.6 s) and the flow model's `recoverExpired` 10 s
  deadline. Neither reproduced: the flow model passed 6 of 6 standard runs and its replay, and `connection.fault` alone passed 8 tests in
  281 s. The cause is not proven; a stall of the host or the scratch Postgres is suspected, not shown. The rerun of the whole gate was
  clean.
- `--grep flow` over the flow suites: 175 pass.
- Panel e2e on Chromium and WebKit: 54 of 54 pass (2.2 min). Firefox cannot launch in this sandbox.
- The first e2e run had one WebKit failure, `operations.e2e.ts` "enqueues from Add Job". Its page snapshot shows the Queues page at
  "1–15 of 27 queues", page 1 of 2, so the spec's queue was on page 2. The list is paged at 15 by name and every spec of both browsers
  adds queues to the one store (task 51 added eight `flow-*` queues), so a queue named `operations-…` fell off page 1 once enough
  queues sorted before it; WebKit runs after Chromium, with more queues present. It is the spec's fault, not the page's: the spec now
  types the queue name into the page's filter (which filters the whole list) before it looks for the link. That run is the evidence for
  the cause; I did not reproduce the failure on purpose before the fix. The same spec passed alone because the store then held few
  queues. The fixed spec passes in the full run.

**Not run**

- The Docker-backed gate (PG 16 DDL snapshot and EXPLAIN for migration 7 and the flow read paths, PgBouncer, TLS) and `bun run
  test:model` under every compose profile: owed to the end of the plan, as agreed.
- Firefox e2e: it cannot launch in this sandbox (`sandbox_extension_issue_file_to_process`). Chromium and WebKit ran.
- A flow on a real cloud (D9).
- The 1,000-job flow ceiling is still not measured against lock counts.

**Found and fixed**

- Every selection of a job read the flow again: react-router's `setSearchParams` changes identity with the address and sat in an effect's
  dependencies. Read through a ref now; a test counts the reads.
- A new flow that reused the id of a cancelled or removed parent showed that parent's old children; `addFlow` detaches them.

**Owed / for the final message:** see the Owed list in [the completion doc](../../completions/2026-10-15-51-flows-control-api-and-panel.md).
