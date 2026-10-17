# 31 — Control API: dashboard, queues, jobs, inspector

**Status:** done locally · **Depends on:** 30 · **Phase:** 2

## Goal

The read and write endpoints behind the panel's Dashboard, Queue Control, Add Job and Job Inspector pages, served from `StateStore`, with the panel's existing paths and shapes.

## Scope

In: `/dashboard`, `/queues/summary`, `/queues/:q/*` (list, pause, resume, drain, clean, obliterate, rate limit, concurrency), `/queues/:q/jobs/list`, `/jobs/:id/*` (get, logs, state, promote, retry, remove, cancel, update data, priority, delay), `POST /queues/:q/jobs` (add), `/jobs/by-custom-id/:id`.
Out: DLQ, cron, workers, events (32); flow endpoints (51).

## Reference

Panel: `src/lib/bq/queueApi.ts`, `serverApi.ts`, `api.ts`; pages `src/pages/control/{AddJob,QueueControl,JobInspector,Dashboard}*`; `docs/api-mapping.md` for the existing path table.
Upstream behaviour: `../qelay/src/infrastructure/persistence/postgres/{readModels,queries,queryCache,rows}.ts` and its job and queue protocol handlers.

## Steps

1. **Read models:** map `StateStore` reads onto the panel's response shapes: queue summaries (counts by state, paused, rate limit, concurrency), job lists (by state, with limit/offset and a total), job detail (data, opts, progress, logs, stacktrace, attempts, lease info, parent/children links, timings).
2. **Payload fidelity:** decode msgpackr to JSON-safe values, with an explicit tagged encoding for values JSON cannot carry (bigint, Date, Map, Set, Uint8Array); the panel shows the tag and does not guess. Truncate very large payloads in list responses with a `truncated` marker; the detail endpoint returns the full value up to a configured cap.
3. **Operator actions** with the panel's safety rules intact: pause/resume/rate-limit/concurrency are plain mutations; drain, clean and obliterate need an explicit confirmation field (`confirm: <queue name>`) and an `operator` role; job actions (promote, retry, remove, cancel, change data/priority/delay) are fenced by the job `version` (take an `expectedVersion` where the panel can provide one) and return 409 on a mismatch.
4. **Add job:** `POST /queues/:q/jobs` through the SDK producer path so dedup, custom IDs, priority and delay behave exactly as the SDK does, including ringing the doorbell.
5. **Pagination limits:** a maximum page size; `offset` beyond a bound uses a keyset cursor (record the decision). No unbounded list.
6. **Cache:** a short TTL cache (a few seconds) for `/dashboard` and `/queues/summary`, with a bypass header for the panel's manual refresh; the cache is per instance and must not serve one namespace's data to another.
7. **Not-supported endpoints:** `/server/*`, `/database/*`, `/backup/*`, `/fleet/*` return `501 not_supported` with the capability name (matching `hidden` in `/capabilities`).
8. **Contract tests** for every endpoint against the panel's shapes; behaviour tests for each action including the version-mismatch 409 and the confirmation requirement.

## Acceptance

- Every endpoint the Dashboard, Queue Control, Add Job and Job Inspector pages call returns a shape the panel parses (contract tests green).
- Destructive actions without the confirmation field are rejected; with a stale `expectedVersion` they return 409 and change nothing.
- Job detail for each payload type round-trips through the tagged encoding without loss (bigint, Date, Map, Set, bytes).
- Namespace isolation: a token or request scoped to one namespace cannot read or change another's jobs (test).
- Responses stay within the configured size cap on a queue with 100k jobs.

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/control-api --grep "queues|jobs|dashboard"
```

## Risks / notes

- The panel assumes Qelay's exact field names. A silent rename breaks a page without a type error; the contract tests exist to catch that, so keep them strict.
- Counts per state on a big table are the likeliest slow query; reuse the plan work from task 15.
- Retrying or changing a job that is `active` must not corrupt its lease; operator actions on an active job are rejected or are defined in terms of the lease (decide in task 06, enforce here).

## Result

**Done locally, on PostgreSQL 18.6 (not the Docker PG 16 of CI); no cloud touched.** The whole suite ran with the database up and
`QCLOUD_REQUIRE_DB=1`: 2,046 pass, 114 skip (the Docker-backed suites), 1 fail, 167 files. The one failure was a flaky test of task 30
(`pipeline.edge.test.ts`, found and fixed below); with it fixed, `bun test packages/control-api` is 316 pass, 0 fail, and the static
gate (`typecheck`, `lint`, `format:check`, `architecture`) is clean. `bun run test:model` ran as well, because the task adds store
methods that touch job rows: 17 pass, 0 fail. No claim, lease, retry or tick semantics changed.

**Built**

- **Store** (`packages/store-postgres/src/store/`): the read models (`readModels`: `queueSummaries`, `dashboard`, `jobsByState`,
  `jobByCustomId`, `priorityCounts`), the operator edits (`control`: `details`, `detailsMany`, `failure`, `updateData`, `changeDelay`,
  `updateProgress`, `remove`, `drain`, `cleanPending`, `obliterate`), queue config (`queues`) and throughput. Every one is index-only, a
  keyed read, or a bounded batch; each new query path has a row in `schema.planned.ts` / `schema.planned.operator.ts`. No migration: the
  existing schema carries it.
- **Routes** (`packages/control-api/src/routes/`): `queues.ts` (summary, counts, paused, `/dashboard/queues`, `/dashboard/queues/:q`),
  `queueOps.ts` (pause, resume, drain, clean, obliterate, promote-jobs, rate limit, concurrency), `jobs.ts` (list, get, custom id, result,
  logs, children, progress), `jobActions.ts` (data, priority, delay, promote, remove; the four closed routes), `addJob.ts` (single and bulk
  through the producer path, so dedup, custom ids and the bell behave as the SDK's), `unsupported.ts` (`/server/*`, `/database/*`,
  `/backup/*`, `/fleet/*` as 501 `not_supported` with the capability), `stats.ts` and `jobsModule.ts` (the wiring).
- **Support** (`src/jobs/`): `payload` (the tagged wire encoding and the truncation marker), `model` (the panel's job shape, timeline
  capped at 20), `pagination` (offset and keyset cursor), `limits` (every bound and its default), `queueActions` (batched drain, clean and
  obliterate under a time budget), `ring`, `context`, `dashboardReader`; `src/cache.ts` (`TtlCache`, per instance, bypass header);
  `src/http/router.ts` gained a trailing `*` wildcard (tried last).
- **Tests** (`packages/control-api/test/`, 316 in 25 files now; 118 match the Verify filter): `queues.read` 12, `dashboard` 8, `jobs.read` 14,
  `jobs.actions` 16, `queues.actions` 13, `jobs.add` 14, `jobs.scale` 5 (a 100,000-job queue), `queues.boundaries` 11 (two namespaces on
  one database, the 501 surfaces, the action budget), `jobs.model` 3, `payload` 17, `router` 12, `openapi` 12, `openapi.jobs` 5,
  `contract/jobs.contract` 10 (the panel's own validators on the served bodies). Store tests: `control.*`, `operator.*`, `read.models`,
  `read.plans*` in `packages/store-postgres/test/`.
- **Docs:** `docs/openapi.yaml` (57 operations, every schema, parameter and error response; a test keeps it equal to what is served),
  `packages/control-api/README.md` ("Jobs and queues"), DESIGN.md section 6 ("As built (task 31)"), `docs/compat.md` (the HTTP add job
  options), `docs/PORTING.md` (three rows for the panel files copied into the contract tests).

**Measured** (PostgreSQL 18.6, one connection, local; `jobs.scale.test.ts`)

- A 500-job list page: 270 KB and 37 ms. 500 jobs with 20 KB payloads: 410 KB (each cut to the 1 KiB list budget). A queue page: 2 KB.
- Counts, summary, dashboard and queue page of a 100,000-job queue together: 79 ms (index-only aggregates; cached 2 s per instance after).
- `offset` to 100,000 is served; past it the answer is 400 with `details.use: "cursor"`, and three cursor pages walk 300 distinct jobs.

**Acceptance**

- Every endpoint Dashboard, Queue Control, Add Job and Job Inspector call returns a shape the panel parses: `contract/jobs.contract.test.ts`
  runs the panel's `parseQueueSummaryPayload`, the job inspector's `jobValidation` (state, integers, `progress`, a timeline of at most 20,
  `backoffConfig`, the custom-id lookup and the `/result` envelope) and the panel's types at compile time, for each job state.
- Destructive actions without `confirm` are 400 `confirmation_required`; a stale `expectedVersion` is 409 `version_conflict` and the job is
  unchanged (`jobs.actions`, `queues.actions`); a viewer is 403 on every write route.
- Job detail round-trips each payload type without loss: bigint, Date, Map, Set, bytes, `undefined`, nested (`payload.test.ts`, `jobs.read`,
  `jobs.add`). **`-0` is not preserved**: the store's own codec turns it into 0 before the API sees it.
- Namespace isolation: a job, a custom id, a queue and the cache of one namespace are invisible to another's API on the same database
  (`queues.boundaries`).
- Responses stay within the size cap on a 100,000-job queue (`jobs.scale`).

**Found by the tests and fixed** (a failing test first for each)

- **Timeline over the panel's limit.** A job with 20 failed attempts got a 23-entry `timeline`; the inspector rejects more than 20 entries.
  Capped at 20: creation plus the newest 19 (`MAX_TIMELINE`, `jobs.model.test.ts`).
- **`/jobs/:id/result` had no `id`.** The inspector requires `{ ok: true, id }` and compares the id it asked for. Added.
- **A flaky test of task 30** (`pipeline.edge.test.ts`): the check that no secret reaches the log searched the whole record, including the
  random request id, and a UUID containing `abc` failed the build about once in 70 runs. Reproduced with a request id that spells `abc`;
  the id is now left out of the search.
- The router could not take `/jobs/custom/:customId` beside `/jobs/:id/logs`; it now has a trailing wildcard tried last and literal
  segments before `:param`. A `*` that is not last throws at startup (`router.test.ts`).

**Decisions** (none changes the design; all are in DESIGN.md "As built (task 31)")

- `expectedVersion` is **optional** on the wire: the panel does not send one yet. Task 34 makes the panel send it.
- Closed in v1 (501 `not_supported`, capabilities `job-retry`, `job-fail`, `job-discard`, `job-move-to-delayed`): retrying a failed job
  (task 14 (k)), `fail`, `discard`, `move-to-wait`, `move-to-delayed`. Changing a job's `lifo` is 501 too.
- `drain`, `clean` and `obliterate` are bounded by `actionBudgetMs` (20 s) and answer `done: false`; the panel's call with no body gets
  400 until task 34 sends `confirm`.
- Counts are index-only aggregates: `waiting` excludes `prioritized` (as the panel's summary has both), and `paused` counts the waiting and
  prioritized jobs of a paused queue. Rates are deltas of the journal between two reads, so the first read answers 0. Latency is empty.
- A job's `version` restarts at 0 when a finished job's custom id is replaced by a new add (task 18's rule); an action with the old
  `expectedVersion` can therefore match the new job. Carried from task 18, with the cross-queue replacement question.
- The worker-protocol routes (`/jobs/heartbeat-batch`, `/jobs/ack-batch`, `/queues/:q/jobs/pull-batch`) are not served: workers use the SDK.
- `durable: true` is accepted and ignored; `durable: false`, `ttl`, `repeat`, `dependsOn`, `tags` and numeric retention are 400
  `unsupported_option` naming the option. The default job name is `default`.
- `/jobs/custom/:id` beats `/jobs/:id/logs` for a job whose id is literally `custom`; such a job is reached by `GET /jobs/custom/custom`.
- Job logs are bounded only by the store's own caps. A job's children are empty until flows (task 51).

**Not done here, by design**

- DLQ, cron, workers, events and metrics are task 32; flows are task 51; the panel is edited in task 34 (error shape, `confirm`,
  `expectedVersion`, `/capabilities`).
- `/capabilities` still declares SQS as a literal (task 40 replaces it).
- `jobs.options` are not read from the environment; task 37 maps variables onto them.

**Owed:** nothing for this task beyond the plan-wide Docker-backed gate (PG 16, PgBouncer, TLS, ElasticMQ, `test:model` with every compose
profile, the PG 16 snapshot and EXPLAIN recheck).
