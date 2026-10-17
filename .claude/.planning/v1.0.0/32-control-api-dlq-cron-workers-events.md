# 32 — Control API: DLQ, cron, workers, events (SSE), metrics

**Status:** done locally · **Depends on:** 31 · **Phase:** 2

## Goal

The remaining must-have panel surfaces: the dead-letter queue, cron schedules, workers, the live event stream and throughput metrics.

## Scope

In: `/queues/:q/dlq/*`, `/crons`, `/workers`, `/events` (SSE), `/metrics/*`, `/stats`.
Out: flows (51), webhooks (52), workflows (62).

## Reference

Panel: `src/pages/control/{DlqControl,CronManager,WorkersPro,Diagnostics}*`, `src/lib/bq/serverApi.ts` (`/events`, `/stats`, `/crons`, `/workers`), `src/features/queue-operations`.
Upstream: `../qelay/src/infrastructure/persistence/postgres/{dlqLifecycle,dlqMaintenance,crons,events,eventJournal,workers}.ts`.

## Steps

1. **DLQ:** list entries with reason, attempts, last error and timestamps; stats; purge (confirmation field); per-entry retry and retry-all **only if** task 14/06 kept DLQ retry; otherwise return `501 not_supported` with the same fail-closed message the panel shows today. DLQ configuration is read-only where the panel already treats it as read-only (`maxAge`/`maxEntries`).
2. **Cron:** list, create, update, delete, with cron expression and interval forms, timezone, limits and next-run times computed by the same parser as the store. Validate the expression server-side and return a precise error. Show `executions`, `maxLimit`, `lastRun`.
3. **Workers:** list from `qcloud_workers` with queues, concurrency, last heartbeat, active job count and a derived `stale` flag. A worker removed from the table is shown as gone, not as an error.
4. **Events (SSE):** `GET /events?queue=&types=&cursor=`; backed by `store.readEvents` with a poll loop plus the transport wake where available; supports `Last-Event-ID` resume; heartbeats every 15 s; closes after a maximum lifetime so clients reconnect through the load balancer; a per-principal connection cap; backpressure: drop the connection if the client falls behind by more than a bound.
5. **Metrics:** throughput and failure rates per queue from the metric buckets (range and resolution parameters with limits), plus job latency and wait-time percentiles if the buckets support them (otherwise omit the field, do not fabricate it).
6. **`/stats`:** the panel's header numbers (total jobs by state, workers, queues) from cached read models.
7. **Audit log:** record every operator mutation (who, what, target, time) in `qcloud_audit` (add the table through the migration runner from task 11); expose `GET /audit` read-only for operators. No payloads in audit rows.
8. **Tests:** SSE resume with no gaps or duplicates; connection cap; slow-client drop; cron validation matrix; DLQ purge confirmation; audit rows written for each mutation, including rejected ones with the reason.

## Acceptance

- The panel's DLQ, Cron Manager, Workers and Diagnostics pages work against the API in contract tests.
- SSE resumes from `Last-Event-ID` with no missing or repeated events under concurrent writers.
- A client that stops reading is disconnected without growing server memory (test with a stalled socket).
- Every operator mutation produces an audit row; the audit endpoint exposes no job payloads.
- Cron expressions that Qelay accepts are accepted; invalid ones get a specific error.

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/control-api
```

## Risks / notes

- Long-lived SSE connections interact with load balancer timeouts on both clouds (Cloud Run request timeout, ALB idle timeout). The maximum lifetime and heartbeat interval must sit comfortably under both; record the numbers in task 36 and 43.
- An audit table is new relative to Qelay. Keep it minimal, append-only and bounded by retention.
- If the panel's DLQ retry stays closed, say so clearly in the UI via `/capabilities`, not by a failing request.

## Result

**Done locally, on PostgreSQL 18.6 (not the Docker PG 16 of CI); no cloud touched.** The whole suite ran with the database up and `QCLOUD_REQUIRE_DB=1`: 2,170 pass, 114 skip (the Docker-backed suites), 0 fail, 178 files, and the static gate (`typecheck`, `lint`, `format:check`, `architecture`) is clean. The Verify filter, `bun test packages/control-api`, is 418 pass, 0 fail in 35 files. `bun run test:model` was not run: the task adds a table and a read-only batch lookup and changes no claim, lease, retry, tick or job-row semantics.

**Built**

- **Store** (`packages/store-postgres/`): the operator audit log. Migration v5 (`schema/ddl/audit.ts`) adds `qcloud_audit`, the only
  schema change; `store/audit.ts` is `store.audit` with `begin`, `finish`, `record`, `list` and `prune` (two-phase, append-only,
  90 days or 100,000 rows, a page of at most 500). `store/jobFailure.ts` gained a batched lookup (`JOBS_FAILURE`, at most 1,000 ids
  by primary key) so a DLQ page reads its reasons in one query. New plan rows in `test/schema.planned.operator.ts`; the DDL
  snapshot was regenerated (PG 18: regenerate it on PG 16 with the Docker run).
- **Routes** (`packages/control-api/src/routes/`): `dlq.ts` (list, stats, remove one, purge with `confirm`, the closed retry routes),
  `queueConfig.ts` (stall and DLQ configuration), `crons.ts`, `workers.ts`, `events.ts` (SSE), `metrics.ts` (`/metrics`,
  `/metrics/queues/:q`), `serverStatus.ts` (`/ping`, `/storage`, and 501 for `/gc`, `/heapstats`, `/prometheus`), `audit.ts`
  (`GET /audit`), all mounted by `jobsModule.ts`. `unsupported.ts` now takes the write verbs of the server pages as operator-only
  and audited.
- **Pipeline** (`src/audit/auditor.ts`, `src/app.ts`): a row is opened before a mutating handler runs and closed with the outcome;
  a viewer's refused attempt and a rate-limited one are rows too; if the row cannot be opened the change is not made (503
  `audit_unavailable`). **Support:** `src/jobs/{dlqModel,cronModel,workerModel}.ts`, `src/events/{frames,gate,stream}.ts`.
- **Tests** (`packages/control-api/test/`): `dlq` 13, `queueConfig` 10, `crons` 16, `workers` 7, `events` 12, `events.limits` 11,
  `metrics` 9, `audit` 12, `openapi.ops` 5, `contract/ops.contract` 7 (the panel's own `parseWorkersPayload`, `parseFrame`,
  `activityPayload`, `shouldDiscardLastEventId` and its types at compile time). Store: `audit` 13, `control.failure` extended.
- **Docs:** `docs/openapi.yaml` (83 operations, 61 paths; a test keeps it equal to what is served, and pins the body keys of the
  new schemas), `packages/control-api/README.md` ("DLQ, cron, workers, events, metrics and audit"), DESIGN.md section 6 ("As built
  (task 32)"), `docs/compat.md` (the DLQ and settings routes), `docs/PORTING.md` (three rows for the panel files copied into the
  contract tests).

**Acceptance**

- **DLQ, Cron Manager, Workers and Diagnostics pages work in contract tests.** `contract/ops.contract.test.ts` runs the panel's
  validators on the served bodies: DLQ page and stats, both settings forms, the workers page (every worker kept, none quarantined),
  a cron form with every field the dialog sends, read back as the panel types it.
- **SSE resumes from `Last-Event-ID` with no gap and no repeat under concurrent writers** (`events.test.ts`: 40 concurrent
  writers make 120 events, a client hangs up after 15 frames and resumes from the last id, and the frames it saw join the
  journal's own order exactly).
- **A client that stops reading is disconnected and the journal is not read ahead of it** (`events.limits.test.ts`: the store is
  asked for one page and no more while nobody reads, then the stream drops the client after `slowClientMs` and frees its place).
- **Every operator mutation produces an audit row, and the endpoint exposes no payload.** `audit.test.ts` walks every documented
  non-GET operation and asserts exactly one closed row with the route's own name and the status it answered; a payload, a query
  string and the token are searched for in the log and not found.
- **Cron:** whatever Qelay's parser accepts is accepted (interval and expression forms, timezones, limits), and an invalid
  expression is 400 `unsupported_option` naming the option (`crons.test.ts`).

**Decisions** (none changes the design; all are in DESIGN.md "As built (task 32)")

- **DLQ retry stays closed** (task 14 (k)): 501 `not_supported`, and `GET /capabilities` lists `dlq-retry` under `unsupported`, so
  the panel hides the button and does not offer a request that fails. Retention (`maxAge`, `maxEntries`) and auto-retry changes are
  501 too (`dlq-retention`, `dlq-auto-retry`): the store can delete a flow's job through retention without a dependency check. A
  save that sends the current values is accepted.
- **DLQ purge takes `{ confirm: <queue name> }`**, like drain, and is bounded by the action budget; the panel's call has no body
  and gets 400 until task 34.
- **SSE is a poll of the journal** (`pollMs` 1 s), not a push: the transport has no journal wake-up, and an in-process hub would not
  reach another instance anyway. Heartbeat 15 s, a stream closed at 10 minutes (the client resumes), 10 streams per principal,
  200 per instance, a 256 KiB buffer.
- **Load balancer numbers for tasks 36 and 43:** heartbeat 15 s; maximum lifetime 600 s; server idle timeout 255 s (Bun's
  maximum); the panel treats 45 s of silence as a dead link. Cloud Run's request timeout must be at least 600 s (its maximum is
  3,600 s) and an ALB's idle timeout at least 30 s (its default is 60 s).
- **Not stored, so not shown:** a cron's `lastRun` (the store keeps `nextRun`, `executions` and `updatedAt`; the panel has no field
  for it, and a nullable column could add it), latency and wait-time percentiles (the metric buckets count, they do not time; the
  field is omitted and not estimated, as the task said), a worker's `currentJob` (always null), a job `name` in an event frame.
- **Audit is not written for a 401 or an unknown route** (nothing was identified or changed), and a failure to prune old rows is
  swallowed (it must not fail a change). `GET /audit` is operator-only, and 501 `not_implemented` when no log is configured.
- **The server-page prefixes answer 501 for writes as well, and need an operator:** a refused attempt is an audited attempt, and a
  viewer gets 403 and the attempt is on record.

**Found by the tests and fixed**

- The audit sweep found `POST /server/*` (and the other server prefixes) answering 501 with no audit row, because the wildcard
  routes were `read` for every verb. Non-GET verbs are `write` now.
- The workers contract expected the queue list in registration order; the store returns it sorted. The expectation was wrong, not
  the store.

**Owed**

- The DDL snapshot, the EXPLAIN plans and the index rows were produced on PG 18.6: regenerate and recheck on PG 16 in the Docker run.
- The panel adaptation (task 34): the drain, obliterate and DLQ purge confirmations, `expectedVersion`, and reading `/capabilities`.
- A Docker-backed run of everything that needs PgBouncer, TLS, ElasticMQ and the Pub/Sub emulator.
