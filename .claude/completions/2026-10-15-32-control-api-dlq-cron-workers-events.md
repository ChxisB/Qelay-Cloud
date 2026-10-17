# Task 32: Control API, DLQ, cron, workers, events, metrics and the audit log (2026-10-15)

**Done locally. No cloud resource was touched** (no `terraform apply`, no `gcloud` or `aws` command). Everything ran against the local
PostgreSQL 18.6, not the Docker PG 16 of CI.

**Changed files**

- `packages/store-postgres/src/`: `schema/ddl/audit.ts` and `schema/migrations.ts` (migration v5, `qcloud_audit`), `store/audit.ts`
  (`store.audit`), `store/jobFailure.ts` (batched lookup), `store/{context,controlApi,facets,settings}.ts`, `postgresStore.ts`,
  `index.ts`. Tests: `audit.test.ts`, `control.failure.test.ts`, `finishHelpers.ts`, `schema.planned.operator.ts`,
  `schema.snapshot.txt` (regenerated on PG 18).
- `packages/control-api/src/`: `routes/{dlq,queueConfig,crons,workers,events,metrics,serverStatus,audit,unsupported,jobsModule,
  capabilities}.ts`, `jobs/{dlqModel,cronModel,workerModel,limits,actionSchemas}.ts`, `events/{frames,gate,stream}.ts`,
  `audit/auditor.ts`, `app.ts`, `deps.ts`, `types.ts`, `http/router.ts`.
- `packages/control-api/test/`: `dlq`, `queueConfig`, `crons`, `workers`, `events`, `events.limits`, `metrics`, `audit`,
  `openapi.ops`, `contract/ops.contract`, `sse.ts` (a frame reader), `contract/shapes/{panel-ops-types,panel-workers,panel-sse,
  ops-schemas}.ts`.
- `docs/openapi.yaml` (83 operations), `docs/PORTING.md` (3 rows), `docs/compat.md`, `DESIGN.md` (section 6),
  `packages/control-api/README.md`.
- Task file (Result, status), `CURRENT.md` (row 32, 23 of 42).

**Checked**

- `bun run typecheck && bun run lint && bun run format:check && bun run architecture`: clean.
- `bun test packages/control-api`: 418 pass, 0 fail (35 files). Store audit and failure tests: 19 pass.
- `QCLOUD_REQUIRE_DB=1 bun test` (all): 2,170 pass, 114 skip, 0 fail (178 files, 292 s). The skips are the Docker-backed suites
  (PgBouncer, TLS, ElasticMQ, Pub/Sub emulator).
- `bun run test:model` not run: no claim, lease, retry, tick or job-row semantics changed.

**Measured**

- The SSE tests run on a 5 ms poll and a 100 ms heartbeat; the shipped defaults are a 1 s poll, a 15 s heartbeat, a 600 s lifetime.
- Load balancer numbers recorded for tasks 36 and 43: a request timeout of at least 600 s on Cloud Run, an idle timeout of at
  least 30 s on an ALB, against a 15 s heartbeat and the server's 255 s idle timeout.

**Decisions** (details in DESIGN.md "As built (task 32)")

- The audit row is opened before the change and closed after it; if it cannot be opened, nothing changes (503 `audit_unavailable`).
- DLQ retry, DLQ retention and auto-retry changes are closed (501, named in `GET /capabilities`); the purge needs `confirm`.
- Events are a poll of the journal, ordered by commit position, with a cap per principal and per instance and a drop for a client
  that does not read.
- Cron `lastRun`, latency percentiles, a worker's `currentJob` and a job name in an event frame are not stored and so not served.

**Found and fixed**

- The server-page write routes (`/server/*` and the other three prefixes) answered 501 with no audit row; they are `write` access
  for POST, PUT and DELETE now, so a viewer gets 403 and every attempt is on record.
- A workers contract expectation of mine had the queue list unsorted; the store sorts it.

**Owed**

- Regenerate the DDL snapshot and recheck every plan row on PG 16 (migrations v3, v4, v5 were written on PG 18).
- Task 34: the panel sends `confirm`, `expectedVersion` and reads `/capabilities`; until then its drain, obliterate and DLQ purge
  buttons get 400 `confirmation_required`.
- Decide whether a cron's `lastRun` is worth a nullable column; the panel has no field for it today.
- Decisions carried to the user: see the list in CURRENT.md and DESIGN.md (tick re-ring amplification, rate-limit and concurrency
  claim serialization, the journal commit lock, cross-queue custom-id replacement).
