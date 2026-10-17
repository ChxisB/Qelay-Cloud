# 71 — Observability and runbooks

**Status:** done locally · **Depends on:** 43 · **Phase:** 6

## Goal

Operators can see that the system is healthy, get alerted when it is not, and know what to do next. Metrics, logs, traces, alerts and runbooks for the failure modes the design predicts.

## Scope

In: the `Telemetry` adapters, structured logging conventions, dashboards and alert definitions as code, and one runbook per predicted failure mode.
Out: paging integrations beyond the cloud's native alerting, cost reporting.

## Steps

1. **Telemetry adapters** for the interface from task 20: OpenTelemetry (OTLP) as the common path, with Cloud Monitoring/Trace and CloudWatch/X-Ray reachable through the collector or the cloud's OTLP endpoint. Metrics: claim latency, claims per second, empty-claim rate, ring failures, doorbell depth and age, DLQ depths (Qelay and transport), tick duration and last-success age, backlog per step, lease losses, retries, connection-pool usage, event stream clients.
2. **Logging:** structured JSON, a request or job ID on every line, a documented set of fields, a rule against logging payloads or secrets (with a test that scans log output of the scenario suite for known secret patterns).
3. **Tracing:** propagate a trace context from `Queue.add` through the doorbell and the claim to the worker's processing span, and into `complete`/`fail`. Keep it opt-in.
4. **Alerts as code** (Terraform under `infra/*/monitoring`, using the inputs reserved in tasks 21 and 42): tick age, doorbell backlog age, transport DLQ not empty, Qelay DLQ growth rate, database connections near budget, claim latency p99, worker count zero with a backlog, control-plane 5xx rate. Each alert links to its runbook.
5. **Runbooks** (`docs/runbooks/`): tick stopped; doorbells piling up; poison doorbells in the transport DLQ (how to inspect and redrive); database connection exhaustion; a lease-loss storm; clock skew; failed migration; rotating the database secret; restoring from backup; draining and cutting over a queue.
6. **Game day:** inject each of the main failures in the local stack (and in a real environment only with D9) and confirm the alert fires and the runbook's steps resolve it. Fix runbooks that did not.

## Acceptance

- Every predicted failure mode has an alert and a runbook, and the runbook was followed once to resolution against the local stack.
- A scan of the scenario suite's logs finds no payloads or secrets.
- Alert definitions validate in Terraform and each carries a runbook link.
- Trace context survives a job end to end in a test (producer span → worker span).

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/telemetry
bun run test:gameday --local        # defined by this task
terraform -chdir=infra/gcp/example validate
terraform -chdir=infra/aws/example validate
```

## Risks / notes

- Alert thresholds chosen before real traffic are guesses. Ship them as defaults and tell the user to tune them after a week of data.
- Do not label something "monitored" until the alert has been seen to fire.

## Result

**Done locally (2026-10-17), on PostgreSQL 18.6, the Pub/Sub emulator and ElasticMQ 1.7.1.** Nothing was applied, pushed or published; no real cloud, no Docker, no migration.
Completion record: [.claude/completions/2026-10-17-71-observability-and-runbooks.md](../../completions/2026-10-17-71-observability-and-runbooks.md).

What exists: `@qelay-cloud/telemetry` (OpenTelemetry metrics and opt-in tracing adapters); the SDK and tick counters and gauges in `docs/observability.md`; a log scan test;
alerts as code in the GCP and AWS monitoring modules and both control planes (each with a runbook link); `docs/runbooks/` (an index and a page per alert and failure mode);
and `bun run test:gameday --local` (18 tests: the failures injected in the local stack, each runbook's fix applied).

Acceptance:

- *Every predicted failure mode has an alert and a runbook, and the runbook was followed once to resolution against the local stack:* **partly.** Every mode has a runbook and
  an alert definition. The game day follows the runbook's own checks and fix for tick stopped, doorbells piling up, drain and cut over, connection exhaustion, slow claims,
  control-API errors, storage growth, failed migration, lease-loss storm, dead-letter growth, clock skew and transport dead letters. Rotating the secret and restoring ran
  as local equivalents (a throwaway role; a `pg_dump` loaded into a second database). Not produced: a full disk, a migration step that fails halfway, Pub/Sub's dead-letter
  depth from Cloud Monitoring, and every provider command (point-in-time restore, `seek`, `purge-queue`, Terraform rotation, the deploy runbooks). The runbook pages say which.
- *A scan of the scenario suite's logs finds no payloads or secrets:* yes, `test/observability/logs.test.ts` (static scan of every log call, and a canary payload and secret sent through the
  API and the SDK).
- *Alert definitions validate in Terraform and each carries a runbook link:* in the offline plans (`check:terraform` exit 0: GCP 136, AWS 794, GCP control plane 113, AWS control plane 2,657
  assertions). `terraform validate` of the two examples was run afterwards: both valid. CI plan counts changed: GCP 57 resources, AWS 89, AWS control plane 37.
- *Trace context survives a job end to end in a test:* yes, producer span to worker span on every attempt, against the OpenTelemetry API and its in-memory SDK
  (`packages/telemetry/test/endToEnd.test.ts`).

**Not shown, and not to be called "monitored":** no alert has been seen to fire on a real cloud (D9 not given). The game day reads the signals an alert reads, through the real Control API
in process with shrunk thresholds (late 1.5 s, stale 4 s); it proves the signal appears and the fix clears it, not that Cloud Monitoring or CloudWatch pages. Thresholds are unproven defaults:
tune them after a week of real data. The alert metric type names for an OTLP exporter are unverified, and the shipped maintenance CLI exports no metrics (the tick gauges are for a process that runs the tick
as a library with `otelTelemetry`), so the slow-claims and jobs-failing-for-good alerts exist only when the metric type is named. GCP worker-idle assumes Cloud Run scale-to-zero behaviour not seen;
tick-absent has the 24-hour absent-series caveat; the AWS worker-idle composite fires only when every listed service is empty and a queue is old. OTLP export was never exercised.

Limits of the tracing: `Queue.add` and `addBulk` only (not flows, cron or workflows); no `tracestate` or baggage; `qcloud.job.attempts_made` is 0 on the first try; a throwing sink `increment` is
swallowed; a tracer whose `produce` rejects before it starts the work would still fail the add.

Found and fixed: Bun.SQL opens the whole `max` pool at once, so `max` is exactly what a drill holds; runbook wording that claimed more than was run was cut back to what was run;
`packages/maintenance/test/tick.test.ts` split to stay under 300 lines. No design deviation to record. Verified with: Full gate on the final tree of tasks 71 and 72 (2026-10-17, PG 18.6 at 55442, Pub/Sub emulator, ElasticMQ, `QCLOUD_REQUIRE_DB/SQS/PUBSUB/TERRAFORM=1`, under `caffeinate`): `typecheck`, `lint` (0 errors, 2 existing panel warnings), `format:check`, `architecture` all exit 0; `bun test` 4,984 pass, 29 skip, 0 fail, 5,014 tests in 495 files, 1,104 s. The two skip warnings printed are the PgBouncer and TLS-Postgres suites (Docker deferred); the other skips were not itemised.
