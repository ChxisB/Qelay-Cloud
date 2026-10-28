# Observability

What Qelay-Cloud tells you about itself, what it leaves for you to wire, and where it stops. Alerts and their runbooks are in
[runbooks](runbooks/README.md); this page is the vocabulary behind them.

## What you get without wiring anything

- **Alerts as code.** The data plane's Terraform creates alert policies (GCP) and alarms (AWS) for the tick, bells that wait,
  dead-lettered bells, database connections, storage (AWS) and a Control API that answers 5xx. Each links its runbook. They
  notify nobody until you give them `notification_channels` (GCP) or `alarm_actions` (AWS).
- **`GET /deployment`** (Control API): database state, the connection budget, the tick's last success, the transport. One call,
  one answer, behind your token.
- **Structured logs.** The Control API writes one JSON record per request; the tick writes one JSON line per error and one
  report line per run; the SDK hands warnings to the `logger` you pass.
- **The panel**: queues, jobs, the transport page (age of the oldest bell, from the cloud's own metric) and the tick.

### The alerts against a usual list

Compared with the alert rules a single-server queue ships (dead letters, no workers, backlog, worker slots, stuck jobs, failure
rate, stale backup). Names are in the [runbook index](runbooks/README.md#from-an-alert-to-its-runbook).

| Usual rule | Here | Gap |
| --- | --- | --- |
| Dead letters above a count | Dead-letter bells (depth and age), and the optional jobs failing for good | None |
| No workers | No worker running while bells wait (GCP), no running tasks and workers idle with backlog (AWS) | None |
| Backlog above a count | Age of the oldest waiting bell | Deliberate: a burst that drains in seconds is healthy, and age is the symptom a user feels. A count alert is one more policy and variable if you want it |
| Worker slots above 95% used | None | The SDK does not report how many of a worker's slots are busy. The autoscalers follow backlog instead |
| Stuck jobs | None as an alert; the tick recovers lost leases and `qcloud.tick.recovered` counts them | The shipped tick exports no gauges, so there is nothing to alert on. See the lease loss storm runbook |
| Failure rate above 5% | Jobs failing for good, optional, a count and not a rate | A rate needs completed and failed together; `qcloud.tick.jobs.*_total` has both, but only through a library tick |
| Stale backup | None | Neither Cloud SQL nor RDS publishes a backup-age metric that could be checked here. Look at the backup list after any change to retention |

None of these thresholds has met a real cloud.

## Logs

| Source | Shape |
| --- | --- |
| Control API, every request | `requestId`, `method`, `route` (the pattern, never the path), `status`, `durationMs`, and when known `role`, `principal`, `errorCode` |
| Control API, a 5xx | `request failed` with `requestId`, `route`, `code` and the failure's class and message |
| Tick, `run` | the run's report as one JSON line on stdout: counts only, and `ok` |
| Tick, an error | `{"level":"error","step":…,"error":…}` on stderr, with every credential of the environment removed |
| Ingest | `{"level":"info","msg":"listening"|"draining"}` at start and stop; `{"level":"error","msg":"lookup failed"|"accept failed"|"reject failed","error":<the error's name>}` at most once in ten seconds; `failed` with a redacted error when the process stops. **No line per request**: a request's path holds its token, so the ingest logs none. The platform does: Cloud Run's request log and a load balancer's access log hold the full path, and so the token ([known issues](known-issues.md), row 12). Read access to those logs is read access to the sources |
| SDK | whatever your `logger.warn(message, context)` receives: ids, queue names, counts, attempts, error text |

Rules the code keeps, and a test enforces (`test/observability/logs.test.ts`, which scans every log call and sends a canary
payload and secret through the API and the SDK):

- A log line never carries a job's `data`, a result, a token, a password or a connection string. A job is named by id and
  queue, not by content.
- No metric is tagged with a queue name, a job name or an id. Every tag is from a small fixed set (`reason`, `operation`, `at`,
  `result`, `step`, `error.type`), so the number of series does not grow with the number of queues, and no cap is needed. A
  per-queue series would need one first (a bound on the queues named, and an `omitted` gauge for the rest), because a
  deployment can hold thousands of queues and a metrics backend bills and slows by series.
- A route is logged as its pattern (`/jobs/:id`), so an id in a path is not a field to search by; use `requestId`, which the
  caller can set with `x-request-id` (8 to 64 characters of `A-Za-z0-9._-`) and which is returned on every response.
- Error text is logged, since it is what you debug with. If a handler puts a secret in its own error message, it is in your log:
  that is yours to keep out.

## Metrics

Metrics reach you only through a sink you pass. `Queue` and `Worker` take `metrics: { increment, observe? }`; the tick takes a
`Telemetry` when you run it in your own process. `@qelay-cloud/telemetry` has OpenTelemetry adapters for both
(`otelMetrics(meter)`, `otelTelemetry(meter)`). Every name starts with `qcloud.`.

### SDK (`Queue`, `Worker`)

| Metric | Kind | Tags | Meaning |
| --- | --- | --- | --- |
| `qcloud.worker.claims` | counter | `result`: `jobs` or `empty` | A claim call, and whether it got jobs |
| `qcloud.worker.claimed` | counter | | Jobs taken |
| `qcloud.worker.claim_ms` | histogram, ms | | The database round trip of a claim |
| `qcloud.add.ms` | histogram, ms | | The database round trip of an add, `addBulk` or one group commit (the store write only, not the ring) |
| `qcloud.add.group_size` | histogram | | Jobs in one group commit (only with `groupCommit`) |
| `qcloud.worker.complete_group_size` | histogram | | Jobs in one `completeMany` write (only with the worker's `groupComplete`) |
| `qcloud.worker.complete_ms` | histogram, ms | | The database round trip of a complete write that got an answer (a write that threw is counted in `settle_failed`, not timed) |
| `qcloud.worker.claim_failed` | counter | | A claim that threw (the worker backs off and tries again) |
| `qcloud.worker.claim_rechecked` | counter | | A bell found nothing to claim while jobs were waiting (locked or not yet visible), so the claim was tried once more |
| `qcloud.worker.malformed_bell` | counter | | A delivery that is not a bell of ours; it is handed back and the broker's redrive policy sends it to the dead-letter queue, where it is never replayed |
| `qcloud.worker.lease_lost` | counter | `at`: the operation or reason | A job whose lease was gone when the worker came to settle or heartbeat |
| `qcloud.worker.settle_failed` | counter | `operation` | A complete, fail or retry write that threw |
| `qcloud.worker.heartbeat_failed` | counter | | A heartbeat the store did not confirm |
| `qcloud.worker.progress_failed`, `qcloud.worker.log_failed` | counter | | A progress or log write that was not stored |
| `qcloud.worker.registry_failed` | counter | | The worker's registration row could not be written |
| `qcloud.ring.rung` | counter | | Bells sent after an add |
| `qcloud.ring.failed` | counter | `reason` | Bells not sent; the job is in Postgres and the tick rings it later |
| `qcloud.ring.deferred` | counter | | A bell left for the tick because it is too far ahead for the broker |
| `qcloud.ring.mark_failed` | counter | | Bells sent but not recorded as sent (a duplicate bell is harmless) |

### The tick

| Metric | Kind | Meaning |
| --- | --- | --- |
| `qcloud.tick.duration` | histogram, ms, tag `step` | One step of a pass (`pass` is the whole pass) |
| `qcloud.tick.errors` | counter, tags `step`, `error.type` | An error by step and error class, never its message |
| `qcloud.tick.last_success` | gauge, epoch seconds | The last pass that was `ok` and had no error: the tick's age is now minus this |
| `qcloud.tick.ok` | gauge, 0 or 1 | The last pass finished its work (every bell rung and recorded, store reachable) |
| `qcloud.tick.recovered`, `promoted`, `cron_fired`, `expired` | gauge | What the last pass did |
| `qcloud.tick.rings.due`, `.rung`, `.deferred`, `.rejected`, `.unreachable`, `.unmarked`, `.skipped` | gauge | The ring step of the last pass |
| `qcloud.tick.webhooks.*`, `qcloud.tick.workflows.*` | gauge | The webhook sender and the workflow sweep. `webhooks.paused` is the webhooks a pass paused after repeated failed deliveries |
| `qcloud.tick.more_work` | gauge, 0 or 1 | A step hit its batch size: another pass would find more |
| `qcloud.tick.jobs.completed_total`, `qcloud.tick.jobs.failed_total` | gauge | Lifetime counts; a rising `failed_total` is the dead-letter queue growing |

A gauge is the value of the last pass, so read the rate of a total, never its level.

## Tracing

Off unless you pass `tracing: otelTracing(tracer)` to a `Queue` and a `Worker`. `Queue.add` and `addBulk` run in a producer span
and store its W3C `traceparent` in the job (at most 256 characters, no schema change); the worker's processing span, which
includes the write that settles the job, is its child on every attempt. A span carries ids, queue, job name, the number of
earlier attempts (`qcloud.job.attempts_made`, 0 on the first try) and counts. It never carries a payload, a result or an error
message; a failure sets the status and the error class.

Not traced: flows, cron-created jobs and workflows (they start a trace of their own at the worker). `tracestate` and baggage are
not carried.

## What is not wired for you

Be exact about the gaps:

- **The shipped tick does not export metrics.** The maintenance CLI (`run` and `serve`) logs errors and its report line and discards the gauges.
  The tick gauges above exist for a process that runs the tick as a library with `otelTelemetry`. So the optional alerts that
  read them (jobs failing for good) need that wiring.
- **The SDK exports nothing by itself.** `qcloud.worker.claim_ms` and the rest reach a dashboard or an alert only through the
  sink you pass and the pipeline behind it (an OpenTelemetry collector into Cloud Monitoring or CloudWatch). The optional
  "slow claims" alert and the "jobs failing for good" alert are created only when you name the metric (`claim_latency_metric_type`
  and `failed_total_metric_type` on GCP, `claim_latency_metric` and `failed_total_metric` on AWS). The metric type a pipeline
  gives a name differs by exporter; the Terraform takes the name you give it, and nothing here has checked a real one.
- **No exporter has been run.** The adapters are tested against the OpenTelemetry API and its in-memory SDK. OTLP export to a
  collector was never exercised.
- **The ingest exports no metrics and has no alert.** Its answers are counted by the load balancer (5xx for a database that is
  down, 429 for the rate limits) and its stored requests by the panel's Requests tab and `GET /requests`. A 5xx alert on the
  ingest's route is the one to add; it was not built.
- **No dashboard** is shipped. The alerts are the contract; the panel and `GET /deployment` are the picture.
- **No alert has fired on a real cloud.** The thresholds are defaults, unproven against real load. Two depend on cloud behaviour
  not yet seen: a Cloud Run service at zero instances (the idle-workers alert) and a log-based signal that is absent for a day
  (the tick alert). The [runbooks](runbooks/README.md#what-was-run) say what was run and where.
- **A broken sink does not break your work.** A metrics call that throws is swallowed by the runtime, and a tracer whose
  `produce` rejects before it starts the work would still fail the add: use a tracer that does not throw.
