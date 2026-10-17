# Task 50: FlowProducer on Postgres (2026-10-15)

**Done locally, on PostgreSQL 18, the Pub/Sub emulator and ElasticMQ.** Flows are written in one transaction, a parent is released
inside the transaction of the child that finishes last, the four failure policies and the operator actions are defined and tested,
and the flow model passes at the standard count and at 1,000 runs. Docker, PG 16, PgBouncer and TLS runs are owed at the end (see
**Owed**). No real cloud was contacted.

**Changed files**

- `packages/core/src/`: `flow.ts` (flattening, policies, limits, `FlowDependencies`, `FlowTree`) and `flow.test.ts` (new), `errors.ts`
  (`FlowError`, `FLOW_INVALID`), `options.ts` (the flow-only options say so), `index.ts`.
- `packages/store-postgres/`:
  - schema: `src/schema/ddl/flows.ts`, migration 6 (`on_failure` on `qcloud_dependencies`), `test/schema.snapshot.txt`.
  - store: `src/store/{flowAdd,flowResolve,flowTerminal,flowReads,flowApi}.ts` (new); `enqueue.ts`, `context.ts`, `fail.ts`,
    `recovery.ts`, `storeContext.ts`, `operator.ts`, `expiry.ts`, `dlq.ts`, `postgresStore.ts`, `src/index.ts` (changed: the terminal
    hook runs in `completeJob`, terminal `failJob` and terminal `recoverExpired`; cancel releases a child's edge).
  - tests: `flowHelpers.ts`, `flow.{add,promote,concurrent,policies,operator,reads,late}.test.ts`, `schema.planned.flow.ts`,
    `schema.indexes.test.ts` (seed and rows for the flow query paths).
- `packages/sdk/`: `src/{flowTypes,flowBuild,flowProducer,flowOps}.ts` (new); `job.ts`, `workerJob.ts`, `workerOptions.ts`, `index.ts`
  (changed); `test/{flowProducer.add,flowProducer.run}.test.ts`, `test/support.ts`.
- `packages/control-api`: `src/errors.ts` (`FlowError` is 400 `flow_invalid`) and its row in `test/errors.test.ts`.
- `test/scenarios/`: `stack.ts` (`flows()`), `scenarios.flows.ts` (4 scenarios), `all.ts`.
- `test/model/flow/` (new, 10 files): `spec`, `reference`, `world`, `invariants`, `command`, `commands`, `operations`, `run`,
  `planted`, `flow.test.ts`.
- Docs: `docs/compat.md` (the `FlowProducer` section; the flow rows of the `Queue`, `Job` and options tables), `docs/limits.md`,
  `docs/PORTING.md` (6 rows and a bullet), `docs/spikes/06-phase0-gate.md` (amendment); `docs/transports.md` regenerated and
  unchanged.

**Checked**

- **The gate, with the database and both emulators up** (PG 18.6, Pub/Sub emulator, ElasticMQ 1.7.1; `QCLOUD_REQUIRE_DB=1`,
  `_PUBSUB=1`, `_SQS=1`): typecheck, lint, format and architecture clean; `bun test` **4,084 pass, 29 skip, 1 todo, 0 fail**, 4,114
  tests in 429 files, 863 s. The 29 skips are the PgBouncer and TLS suites (no Docker yet).
- `bun test packages/store-postgres packages/sdk --grep flow`: 103 pass, 20 skip (PgBouncer and TLS), 0 fail.
- `bun run test:model`: 22 pass, 0 fail (the StateStore model and the flow model together). The flow model alone at 1,000 runs of up
  to 100 commands: pass, 200 s.
- 1,000 repetitions of the last two children completing together: the parent is released once each time (`flow.concurrent`).
- The flow scenarios (4) on memory, Postgres, the Pub/Sub emulator and ElasticMQ, with duplicate bells injected.
- **The first full run failed and the second did not.**
  - Two of the failures were mine and are fixed: the core options test expected the old "not supported in v1.0.0" wording for
    `parent` (now a flow-only option with its own message; the test gained a case for the five flow options), and two store tests
    (`fail.terminal`, `recovery.expired`) compared the exact terminal change, which now carries `error`.
  - The other 235 were panel tests. They began after `useActivityStream > keeps a replay id through a transient frame-less 503
    failure` took 179 s against a 10 s timeout, and then failed with missing DOM elements. `bun test packages/panel` alone gave 1,312
    pass, 0 fail, and the second full run had none. I did not find the cause. A stall of the machine during that test is the likely one;
    it is not proven.

**Measured**

- The flow model: 200 runs of up to 60 commands take about 18 s; 1,000 runs of up to 100 commands take 200 s. Neither found a
  difference between the store and the model. The standard run reaches all 14 rules (the rarest, the two late-failure rules, 6 times
  each); the four planted bugs are found with histories of 8 commands or fewer, and each replays to the same history.
- 1,000 repetitions of the last two children completing together: the parent is released once every time.

**Decisions**

- Written up in the amendment to `docs/spikes/06-phase0-gate.md` ("task 50 put flows on the dependency tables"): the parent row is the
  lock; a late failure is still recorded and drops its edge, and a late `fail` does nothing; the policy lives on the edge (migration 6);
  a failed child with no policy blocks its parent; operator actions each have an outcome; 1,000 jobs per flow; `addBulk` is not atomic
  across flows but is fully validated first.
- Not in the amendment, only here: a promoted parent after a cancel or an expiry is rung by the tick, not at once; the model does not
  generate delays, `removeOnComplete`, DLQ retry or purge.

**Found and fixed**

- A bare JS array parameter to `Bun.SQL`'s `sql.unsafe` failed in the inspector's tree query; it binds `sql.array` now.
- A latent null-parent climb in `resolveFlows` (a failed root was looked up as a child); a filter, and a test.
- `addBulk` wrote the first flow before a later flow's option error; every flow is planned and checked first (`planFlow`).
- A late failure of a `continue` or `ignore` child, after the parent was released, was lost; it is recorded now.
- The tick did not ring a released parent that was younger than `ringGraceMs` in the model's setting; the model sets `ringGraceMs: 0`.

**Owed**

- **The Docker-backed gate at the end of the plan:** PG 16 DDL snapshot and EXPLAIN (migration 6 and the flow query paths were
  generated on PG 18, where skip scan can change a plan), `bun run test:model` with every compose profile, the flow scenarios on the
  compose ElasticMQ image.
- **Not run:** a flow on a real Pub/Sub or SQS (D9). The scenarios ran on the emulators with duplicate bells injected.
- ~~Operator cannot rescue a parent whose child failed with no policy except by cancelling the parent.~~ **Resolved in task 51:** the
  Control API's `retry-failed` and `promote` flow actions (generic job and DLQ retry stay closed).
- **The 1,000-job ceiling is not measured** against lock counts; upstream allows 10,000.
- **Notes for the final message:**
  - migration 6 (`on_failure` on the edge);
  - edges persist after completion and the completion sweep or retention may remove what a finished parent's edges point to;
  - cancel of a child releases its edge while remove, clean, drain, obliterate and DLQ purge or eviction stay guarded;
  - cancelling or removing a parent leaves its children running as plain jobs, with a stale `parent_id`, so a reused parent custom id
    can show an old child in `getFlow`;
  - a child with `removeOnFail` must set a policy; dedup is refused in a flow and a parent cannot be in a group;
  - a failed parent writes DLQ reason `explicit_fail` and counts no `failed` metric;
  - `getDependencies` counts a failed no-policy child as unprocessed (upstream: processed, null);
  - `addBulk` is per-flow transactions, not atomic across flows;
  - flow data is not restricted to objects; a custom id with `:` is refused;
  - `getFlow` omits children removed on completion, and what hangs under them;
  - failure flags are not shown in `job.opts`;
  - a replay whose live root vanished before it could be read throws `FlowError`;
  - the Control API maps `FlowError` to 400 `flow_invalid` but serves no flow endpoint until task 51;
  - the flow model's replay variables are `QCLOUD_FLOW_MODEL_SEED`, `_PATH` and `_REPLAY_PATH`, and `QCLOUD_MODEL_RUNS` and
    `QCLOUD_MODEL_COMMANDS` deepen it.
