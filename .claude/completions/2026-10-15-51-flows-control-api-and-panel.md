# Task 51: Flows in the Control API and the panel (2026-10-15)

**Done locally, on PostgreSQL 18, the Pub/Sub emulator and ElasticMQ.** An operator can list flows, read a flow's tree, and retry the
failed children that hold a parent, release such a parent, or remove a whole flow, from the panel or the Control API. Each action is one
fenced transaction and one audit row. Docker, PG 16, PgBouncer, TLS and Firefox runs are owed (see **Owed**). No real cloud was contacted.

**Changed files**

- `packages/core/src/`: `flowControl.ts` (new: the action, view and limit shapes), `flow.ts`, `index.ts`.
- `packages/store-postgres/`:
  - schema: `src/schema/ddl/flows.ts`, `src/schema/migrations.ts` (migration 7 `'flow membership'`), `test/schema.snapshot.txt`.
  - store: `src/store/{flowView,flowViewSql,flowActions,flowActionSupport,flowRetry,flowPromote,flowRemove}.ts` (new); `flowAdd.ts` (tags
    each job, detaches orphans), `flowApi.ts` (the `roots`, `view`, `childIds`, `act` and `add` facade), `jobDetails.ts` (returns
    `flowRoot`).
  - tests: `flow.act.{retry,promote,remove,atomic,race}.test.ts`, `flow.view.test.ts`, `flow.tags.test.ts`, `flowActionHelpers.ts`,
    `schema.indexes.test.ts` (rows for the two new indexes and the read paths), `schema.planned.flow.ts`, `schema.planned.ts`.
- `packages/control-api/`: `src/routes/flows.ts` (new), `src/jobs/flowModel.ts` (new), `src/jobs/model.ts`, `src/routes/{jobs,jobsModule,
  capabilities}.ts`; `test/{flows.read,flows.actions}.test.ts` (new), `test/openapi.jobs.test.ts`; `docs/openapi.yaml`.
- `packages/panel/src/`:
  - `features/flows/{domain,application,infrastructure,ui}/` (new; replaces the agent-based Flows code): `flowWire`, `flowTree`,
    `flowActions`, `flowUrlState`, `flowConstants`; `FlowRepository`, `useFlowExplorer`, `useFlowActions`, `useFlowList`,
    `flowMessages`; `controlFlowRepository`; `FlowPage`, `FlowList`, `FlowSearch`, `FlowExplorer`, `FlowSummary`, `FlowTree`,
    `FlowNodePanel`, `FlowActionsBar`, `useVirtualRows`.
  - `pages/control/Flows.tsx` (re-export), `pages/control/job/JobFlowLinks.tsx` (new), `lib/demo/{flows,jobs}.ts`.
- `packages/panel/test/`: `flow.helpers.tsx`, `flow-domain`, `flow-wire`, `flow-tree`, `flow-page`, `flow-page-{retry,release,reads}`,
  `flow-page.helpers.tsx`, `flow-inspector-links`, `flow-demo` (91 new panel tests); `control-dom.helpers.tsx` (rewritten after an
  accidental deletion).
- `packages/panel/e2e/`: `flows.e2e.ts` (new, 3 tests), `seeds.ts` (new), `runtime.ts` (`/seed/failed`, `/seed/flow`), `fixtures.ts`
  (`goInApp`), `dashboard.e2e.ts` and `control-api.e2e.ts` (`/flows` is not a closed page any more).
- Docs: `docs/compat.md`, `docs/limits.md`, `docs/PORTING.md`, `docs/spikes/06-phase0-gate.md` (amendment), `DESIGN.md`,
  `.claude/.planning/v1.0.0/50-flowproducer.md` and `.claude/completions/2026-10-15-50-flowproducer.md` (the rescue gap is resolved).

**Checked**

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

**Measured**

- A 5,000-job flow: the tree computes every row in under the 1 s the test allows and draws at most 30 lines; the page opens inside the
  5 s the test allows. These are the tests' bounds, not timings; no timing was recorded.
- The planned-query tests in `schema.indexes.test.ts` pin the index each new flow query path uses (`qcloud_jobs_flow_idx`,
  `qcloud_jobs_flow_roots_idx`), on PG 18.

**Decisions**

Written up in the amendment to `docs/spikes/06-phase0-gate.md` ("task 51 put flows in the Control API and the panel"):

- migration 7 records `flow_root` and `flow_depth`, with two partial indexes, so a flow is one index scan;
- retry is closed generally and open for one case: a failed child that holds a waiting parent (`retry-failed`), never a parent that
  never ran;
- `promote` treats blocking failures as `ignore`, refuses while any child is unfinished, and the request must name every blocking child;
- `remove` is the whole flow or nothing, refused for a running job or more than 1,000 jobs, and needs the root id typed back;
- every action is fenced by `expectedVersion`s; each refusal has its own `flow_*` 409 code; `id_taken` was dropped as unreachable;
- the view is bounded (1,000 jobs by default, 5,000 at most) and not one snapshot, which is why the actions are fenced;
- a new flow detaches the orphans of an old one with the same ids;
- the panel is a Control API client only (no agent create form, methods panel, DAG canvas or recents).

**Found and fixed**

- `useFlowExplorer` read the flow again on every selection (react-router's `setSearchParams` changes identity with the address); a
  ref-backed stable setter, and a test that counts the reads.
- A reused parent id showed the old parent's children (stale `parent_id` and `flow_root`); `tagFlow` detaches them.
- `docs/PORTING.md` carried a test count and a "kept in spirit" row I had not checked; both were corrected against the tests.
- Four files went over the 300-line cap and were split (`flowViewSql.ts`, `e2e/seeds.ts`, the page and domain test files).

**Owed**

- **The Docker-backed gate at the end of the plan:**
  - PG 16 DDL snapshot and EXPLAIN for migration 7 and the flow read and action paths (generated on PG 18; the completions delete plan
    there can use a skip scan, so `schema.indexes.test.ts` accepts `qcloud_completions_queue_idx` as an alternative);
  - the flow suites under PgBouncer and TLS; `bun run test:model` with every compose profile.
- **Firefox e2e:** it cannot launch in this sandbox (`sandbox_extension_issue_file_to_process`). Chromium and WebKit pass.
- **Not run:** a flow on a real cloud (D9).
- **Resolved: the `operations.e2e.ts` "enqueues from Add Job" WebKit failure.** It was the spec: the queue list is paged at 15 by name, the shared e2e store had 27 queues, and the spec's queue was on page 2 (the failure's page snapshot reads "1–15 of 27 queues"). The spec now filters by name; 54 of 54 pass on Chromium and WebKit. (The control Queues page filters across the whole list; the classic `/queues-classic` page pages on the server and filters only the page it shows. That page was not touched.)
- **The 1,000-job ceiling is not measured** against lock counts; upstream allows 10,000.
- **Notes for the final message:**
  - migration 7 and its two indexes; flow-scoped retry is the one retry (generic job and DLQ retry still answer 501);
  - a new flow detaches the orphans of an old one with the same ids;
  - the view shows 1,000 jobs by default and 5,000 at most; children removed on completion are shown as synthetic nodes
    (`version: null`, `removed: true`) and are not in `total` or the state counts;
  - `childrenIds` is on single-job reads only, `dependsOn` is always `[]`, and `/jobs/:id/children` serves real values;
  - the panel disables Remove on a truncated view, and a parent that never ran cannot be retried (release its parent instead);
  - `promote` treats failures as `ignore` and refuses while any child is unfinished;
  - the view is not a single-snapshot read; `id_taken` was dropped as unreachable; each refusal is a distinct `flow_*` 409;
  - `features.flows` is derived from the jobs routes being served;
  - the panel's agent-based Create, per-job methods, DAG canvas and recents were removed for a Control-API-only tree view and a
    server-side list (flows are created with the SDK `FlowProducer`), and the legacy `recentFlows` storage key is dropped (the
    brand-copy-guard count went from 7 to 6);
  - `/flows` is no longer a closed page in the e2e dashboard and control-api specs; the `/seed/flow` e2e route writes straight to the
    store;
  - the shared panel test helper `control-dom.helpers.tsx` was replaced after an accidental deletion (its `changeControl` calls React's
    `onChange` through the element's props, because native events do not reach React in happy-dom).
