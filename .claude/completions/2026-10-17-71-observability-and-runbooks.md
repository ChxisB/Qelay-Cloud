# Task 71: Observability and runbooks (2026-10-17)

**Done locally, on PostgreSQL 18, the Pub/Sub emulator and ElasticMQ. No alert has fired on a real cloud and no runbook has been followed on one.** Metrics, logs,
tracing, alerts as code and runbooks exist, and a local game day injects the failures and applies each runbook's fix. Docker, PG 16 and a real cloud were not used
(see **Owed**). Nothing was applied, pushed or published. No migration was added.

**Changed files**

- `packages/telemetry/`: `src/metrics.ts` (`otelMetrics`, `otelTelemetry`), `src/tracing.ts` (`otelTracing`), `src/traceparent.ts`, `src/index.ts`, `package.json`, `tsconfig.json`;
  tests `metrics`, `tracing`, `endToEnd` and `support`.
- `packages/core/src/jobs.ts` (the stored trace context on a job), `packages/sdk/src/{add,index,jobRunner,options,ring,runtime,workerClaim}.ts` (the counters in
  `docs/observability.md`, the opt-in tracer), `packages/store-postgres/src/store/{claim,prepare}.ts` (carry the context, no schema change),
  `packages/sdk/test/worker.observe.test.ts`.
- `packages/maintenance/src/{tick,telemetry}.ts` (the tick's gauges: `ok`, `last_success`, the ring counts, `jobs.completed_total` and `jobs.failed_total`),
  `packages/maintenance/test/{tick,tick.gauges}.test.ts`.
- `test/observability/logs.test.ts`: scans every log call and sends a canary payload and secret through the API and the SDK.
- `infra/gcp/modules/monitoring/`, `infra/gcp/control-plane/alerts.tf`, `infra/aws/modules/monitoring/`, `infra/aws/control-plane/alerts.tf` (with variables and
  outputs) and the example wiring in `infra/{gcp,aws}/example/`; each alert carries its runbook link.
- `scripts/terraform-plan-alerts.ts`, `scripts/terraform-plan-aws-alerts.ts`, `scripts/terraform-control-plane-alerts.ts` and the edits to the four `check-terraform*.ts`
  scripts that call them.
- `docs/observability.md`, `docs/runbooks/` (the index and one page per alert and planned failure mode, 15 files besides the two deploy runbooks of task 70),
  `docs/operations.md`, `infra/*/README.md`, and the generated `docs/reference/*` and `docs/unsupported.md`.
- `test/gameday/{support,tick,doorbells,database,migration,workers,recovery,transport}` and `scripts/gameday.ts`; `package.json` (`test:gameday`).
- `.claude/.planning/v1.0.0/{71-observability-and-runbooks,CURRENT}.md`.

**Checked** (what was true, with the tests that show it)

- *Metrics:* the SDK and the tick report the names in `docs/observability.md` through a sink; a throwing sink changes nothing (`packages/telemetry/test`,
  `packages/sdk/test/worker.observe`, `packages/maintenance/test/tick*`).
- *Tracing:* a producer span's `traceparent` is stored in the job and the worker's span is its child on every attempt, against the OpenTelemetry API and its in-memory
  SDK (`packages/telemetry/test/endToEnd`).
- *Logs:* no payload, result, token, password or connection string in any log line the repo writes (`test/observability/logs`).
- *Alerts:* every alert in the four Terraform plans carries a runbook link and the names the runbooks give; `check:terraform` exits 0 (GCP 136, AWS 794, GCP control plane
  113, AWS control plane 2,657 assertions).
- *Game day, 18 tests in 7 files* (`bun run test:gameday -- --local`, about 40 s):
  - the tick: stopped (`tick_stale`, one run by hand clears it, workers carried on) and failing (`lastFailureAt` passes `lastSuccessAt`, fixing the broker clears it);
  - doorbells: unrung jobs (`doorbells_overdue`, the tick rings them), bells rung with no worker (the backlog shows in `/queues/.../counts` and `/transport`), and drain and cut over
    (pause, in-flight finishes on the old code, new worker, resume);
  - the database: connections near the limit (`connections_high`, the runbook query names the holder, closing it clears the warning), a fleet that does not fit
    (`connection_budget_exceeded`), a lock on `qcloud_jobs` (Lock waits, `idle in transaction`, ending the holder lets the job run), the database unreachable behind the Control API
    (`/health` up, `/health/ready` 503, a 5xx logged with an id and no token, workers carry on, recovery with nothing done to the API), and growth with `clean` in rounds;
  - a migration: behind (`schema_behind`, 503 ready), current after `migrate`, an edited checksum (`SchemaDriftError`, restoring it is the fix) and ahead (`schema_ahead`, still ready);
  - workers: a lease-loss storm (`lease_lost` and `heartbeat_failed` rise, the job runs twice, the counters stop with a healthy path), jobs failing for good (summary, DLQ stats and entries,
    `failed_total`, retry answers 501, re-adding the work after a fix), clock skew of an hour either way (delayed jobs run on time, the tick's age is unchanged);
  - recovering: a rotated password on a throwaway role (open connections stay, a process that logs in again fails until it has the new one, no job lost) and a restore (a
    `pg_dump` of the schema loaded into a second database: counts and version readable, `migrate` a no-op, the tick rings every claimable job again and a worker runs it);
  - a malformed bell on the Pub/Sub emulator and on ElasticMQ: dead-lettered, listed by `GET /transport/dead-letters` with `jobId` null, SQS `deadLetterDepth` in `/transport`, the job behind it ran once.

**Run** (PG 18.6 at 55442, Pub/Sub emulator, ElasticMQ 1.7.1; `caffeinate` around the long runs)

- Full gate on the final tree of tasks 71 and 72 (2026-10-17, PG 18.6 at 55442, Pub/Sub emulator, ElasticMQ, `QCLOUD_REQUIRE_DB/SQS/PUBSUB/TERRAFORM=1`, under `caffeinate`): `typecheck`, `lint` (0 errors, 2 existing panel warnings), `format:check`, `architecture` all exit 0; `bun test` 4,984 pass, 29 skip, 0 fail, 5,014 tests in 495 files, 1,104 s. The two skip warnings printed are the PgBouncer and TLS-Postgres suites (Docker deferred); the other skips were not itemised.

- Also on the final tree: `bun run test:model` 31 pass (78 s); `bun run docs:check` passed (7 documented blocks run); `bun run test:gameday --local` 18 pass (40 s); `terraform validate` of `infra/gcp/example` and `infra/aws/example`: both valid (providers were already initialised; nothing was applied).

**Decisions**

- The game day reads the signal an alert reads (`GET /deployment`, `/transport`, `/queues/*`) through the real Control API app in process, with the tick's late and stale
  thresholds shrunk to 1.5 s and 4 s so a drill lasts seconds. It proves the signal appears and the fix clears it. It does not prove an alert fires.
- Every metric name starts with `qcloud.`; tick gauges are the last pass's value, so a total is read as a rate (`docs/observability.md`).
- The optional alerts (slow claims, jobs failing for good) exist only when the metric type is named, because the shipped maintenance CLI exports nothing.
- Trace context rides in the job as a W3C `traceparent` (at most 256 characters): no migration.
- `test:gameday` refuses to run without `--local` and ignores `QCLOUD_REAL_CLOUD`: a real-cloud game day does not exist.

**Found and fixed**

- Bun.SQL opens its whole `max` pool at once, so the first connection drill held every connection of the server instead of 85 %; the drill now sizes its pool to what it means to hold.
- Three drills of my own were wrong (a `close()` that kept the readiness probe from reconnecting, a clean call with a `limit` that answers `done: true`, and the pool above);
  none was a defect in the product or the runbooks.
- Runbook claims that were not yet true were reworded to say what was run: rotate-secret, restore, storage-full and transport-dead-letters now say which part the game day
  exercised and which part is a provider command that was not.
- `packages/maintenance/test/tick.test.ts` passed the 300-line limit; the two gauge tests moved to `tick.gauges.test.ts`.

**Owed**

- **No alert has been seen to fire on a real cloud (D9).** Thresholds are unproven defaults. Two depend on cloud behaviour not seen: GCP worker-idle (Cloud Run scale to zero) and
  tick-absent (a log-based signal that is absent for 24 hours). The AWS worker-idle composite fires only when every listed service is empty and a queue is old.
- **The shipped maintenance CLI exports no metrics** (`run`, `serve`): the tick gauges exist for a process that runs the tick as a library with `otelTelemetry`.
- **OTLP export was never exercised**; the adapters are tested against the OpenTelemetry API and its in-memory SDK. The alert metric type names for an exporter are unverified.
- Tracing covers `Queue.add` and `addBulk` only (no flows, cron or workflows), no `tracestate` or baggage. `qcloud.job.attempts_made` is 0 on the first try. A tracer whose `produce`
  rejects before it starts the work would still fail the add.
- Provider commands in the runbooks are untried: `gcloud pubsub subscriptions seek`, `aws sqs purge-queue`, the point-in-time restores, the Terraform secret rotation, both deploy runbooks.
  A full disk, a migration step that fails halfway and Pub/Sub's dead-letter depth from Cloud Monitoring were not produced.
- The Terraform plan counts changed (GCP 57 resources, AWS 89, AWS control plane 37) and the CI `terraform` job with the new scripts was never run on GitHub.
- Docker-backed runs, PG 16 and the sign-offs of tasks 22 and 37 are owed at the end of the plan as before.
