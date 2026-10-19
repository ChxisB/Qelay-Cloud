# Review follow-up: throughput, latency and webhooks

**Requested:** 2026-10-19 ("implement all the recommended changes") from the review artifact
`claude.ai/artifact/MRMiSdRs5jPZ5og13jYRJh` (21 findings, GCP/AWS setup tables, the 5-phase plan, the queue-server and
Outpost sections). Finding numbers `F1`-`F21` below are that review's.

## Ground rules for this run

- Work in the review's phase order. A task is done when its Acceptance is true and its Verify commands were run;
  fill the **Result** line and the table. Write `.claude/completions/YYYY-MM-DD-<task>.md` at the end of each phase.
- Core queue semantics (R09-R13) also run `bun run test:model`. Migrations follow CLAUDE.md (forward-only, old
  workers connected, snapshot regenerated, a row in `schema.indexes.test.ts` for a new query path).
- Out of reach without the owner (D9 / push), so NOT done and listed in the final report: F17 (real Cloud SQL / RDS
  load check), the first CI run on GitHub, any `terraform apply`, any `gcloud`/`aws` write, PG 16 runs (Docker deferred).
- A design that turns out wrong is recorded in the task Result and DESIGN.md, not silently bent.

## Status

| # | Task | Review | Status |
|---|------|--------|--------|
| R01 | SDK group commit for `add` | F8 | done |
| R02 | Hot-table tuning migration | F9 | done |
| R03 | SQS batch delete | F12 | done |
| R04 | Worker role connection cap | F14 | done |
| R05 | Edge protection (Cloud Armor, WAF) | F16 | done |
| R06 | Webhook retry jitter | F20 | done |
| R07 | CI action pins, Dependabot, doc links, null-in-array sweep | F18, F19 | done |
| R08 | Duration histograms for push, claim, complete | phase 0 | done |
| R09 | Batch complete, lighter metrics | F4 | done |
| R10 | Claim again after finishing, ring on empty-to-waiting, re-ring cap | F3, F10 | done |
| R11 | Decoded payload cap | F5 | done |
| R12 | Journal commit-order lock | F1 | done (step 3 not built) |
| R13 | Partition deliveries, delivery retention setting | F2 | done (events not partitioned) |
| R14 | Webhook sender pool: loop, keep-alive, DNS cache, breaker | F6 | done (sender process only) |
| R15 | Delivery rows from the journal by cursor; filters and shaping | F7, Outpost | done (no job data in filters; no panel UI) |
| R16 | Auto-disable, alerts, response capture, always-sign | F15, F21, Outpost | done (no panel UI; no pager or email) |
| R17 | One-second TickLoop worker | F11 | done (no Terraform until R19; no health endpoint) |
| R18 | Pub/Sub topic per hot queue | F13 | done (no real-cloud run; manual move of a live queue) |
| R19 | GCP and AWS setup recommendations in Terraform | setup tables | done (plan only; managed pooling and the AWS cluster unverified) |
| R20 | Admission control, DB timeouts, metric cap, alert list, Firefox | queue-server borrows | done (Firefox never ran; four alerts not shipped; no real cloud) |
| R21 | Shard by namespace across databases | phase 4 | done (explicit map; API one namespace per process; no move tool, no Terraform; not measured) |

## Results

- **R01** `groupCommit` is opt-in (default unchanged, so the documented "no client-side batching" still holds):
  `packages/sdk/src/groupCommit.ts`, 9 tests in `queue.groupCommit.test.ts`. A batch the store refuses is re-checked per job
  with `store.checkJobs`, so one bad job fails alone. Tracing gives one producer span per batch (a `shortcut:` note).
- **R02** Migration 12 sets `fillfactor = 80` and `autovacuum_vacuum_scale_factor = 0.01` on jobs, queue-state, both metric
  tables and webhook deliveries. The schema snapshot now records storage parameters (`OPTIONS` lines). Effect on a real
  drain (`n_tup_hot_upd`, `n_dead_tup`) was not measured; owed to the load check.
- **R03** The SQS receiver acks through a `DeleteBatcher` (`deleteBatch.ts`): up to 10 handles, a 5 ms window, one
  `DeleteMessageBatch` (one billed request, authorised by `sqs:DeleteMessage`), and `ack()` no longer waits for the delete.
  Stale handles are told apart per entry; other failures count once per request. `shutdown` drains it. `deletes` now means
  batch calls and `deletedBells` the bells. Measured on ElasticMQ only: 1.2-2.3 requests per job (narrow) and 0.8-1.6 (wide),
  from three runs, bounds in `cost.test.ts`. The receive loop is demand-driven, so real SQS saves requests only when acks
  land inside the 5 ms window; the saving on a real queue is unmeasured (D9).
- **R04** `workerRoleLimit` / `workerRoleLimitSql` in `budget.ts`, a `worker_role_limit` output of the budget module and of
  both example roots (checked against `budget()` by both plan checks: 167 and 827 checks pass), and
  `connection.roleLimit.test.ts` (the 53300 refusal, on a local Postgres). **Operator-run:** Terraform creates one shared
  database user and runs no SQL, so the role and its grants are documented in `docs/operations.md`, not created. The grants
  are not verified against Cloud SQL or RDS, and the cap protects the control plane only if workers log in as that role.
- **R05** Both are opt-in and off by default, so the base plans are unchanged (37 resources on AWS). AWS: `edge_rate_limit_per_minute`
  adds a regional WAF web ACL with one rate rule per address (429, `Retry-After: 60`) on the existing ALB (`waf.tf`). GCP has no
  load balancer today, and Cloud Armor attaches only to a backend service, so `edge = { api_hostname, panel_hostname,
  rate_limit_per_minute }` builds an external HTTPS load balancer (serverless NEGs, URL map, managed certificate, TLS 1.2+
  policy, one rule) and moves Cloud Run to `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`, with the services named by the host names
  (`edge.tf`). Plan checks: 125 (GCP control plane) and 2664 (AWS control plane) pass, including the refusals. **Never applied
  (D9):** whether Cloud Armor throttles as the rule reads, whether the backend timeout reaches a serverless NEG as set, when the
  managed certificate issues, and what a client behind a shared address sees are unconfirmed. **Open decision:** default-on for
  `exposure = "public"` was not chosen because it adds a bill and can lock out clients behind one NAT. Port 80 is not served on GCP.
  Also found, not mine to fix: `test/docs/release.test.ts` fails on a clean tree because the root `LICENSE` lost the upstream
  copyright line in commit 4103cee and every `packages/*/LICENSE` still has it.
- **R06** `webhookRetryDelayMs(failed, policy, random?)` spreads a wait by plus or minus 20 % when given `random`; a wait at
  `maxDelayMs` is only spread shorter, so the cap holds. The store passes `ctx.backoff.random`, so webhook jitter is **on in
  production** (unlike job retry jitter, which stays off by default) and the `random` store option replays it. Three store
  and sender suites that assert exact waits (`webhook.record`, `webhook.claim`, `webhook.sender`) now inject `random: () => 0.5`
  (a factor of exactly 1). One bounds test in core; `docs/webhooks.md` says the schedule is the centre of the spread.
  The 63.5-minute budget is now 63.5 minutes on average, about 51 to 76 at the extremes; that range was computed, not measured.
- **R07** Actions are pinned to the commit their major tag points at today, with the release in a comment (`checkout` v4.4.0,
  `setup-bun` v2.2.0, `setup-terraform` v3.1.2; read from the remotes with `git ls-remote`, 13 `uses:` lines) and
  `.github/dependabot.yml` updates them weekly. **Not done:** the first CI run (needs a push) and any Postgres 16 run, so F18's
  "CI has never run" stays true. **Doc links:** the review's premise was stale. `.claude/.planning/v1.0.0/` is committed (389b7ce) and all
  eight linked files resolve from a clean `git archive HEAD`, so I removed the "untracked" claims from `known-issues.md` and
  `release-checklist.md` instead of copying pages into `docs/`. **Null sweep:** every `.array(` call (about 100) was read.
  Reproduced the hazard (TEXT: the text "null", silently; BIGINT: error 22P02). Most arrays hold non-null columns or numbers; caller
  text is validated first. Three public id-list reads checked only the list length: `deployment.existing([null])` returned
  `["null"]`. They now run each id through `identifier()`; `array.null.test.ts` covers them and pins the driver behaviour.
  Also fixed a type error in my R04 test that `typecheck` caught (I had not run `typecheck` after writing it).
- **R08** `claim_ms` already existed. Added `qcloud.add.ms` (the store write of an add, `addBulk` or one group commit, timed in
  `admitEach`) and `qcloud.worker.complete_ms` (the complete write in `#settle`, only when it got an answer). Both, and the
  undocumented `qcloud.add.group_size`, are rows in the SDK table of `docs/observability.md`. `otelMetrics` already maps
  `observe` to a histogram, so no telemetry change. One test in `worker.observe.test.ts`; all 239 SDK tests pass. A write that
  throws is not timed (it is counted in `settle_failed`), so a histogram under an outage shows only the answers.
- **R09** `StateStore.completeMany(items)` returns one `Outcome | StoreError` per item and runs set-based in one transaction:
  rows locked `ORDER BY id FOR UPDATE`, a fence per lease (active, this token, lease not due), one bulk insert of completion
  records, one `UPDATE ... FROM`, journal events, the terminal hook, and one metrics upsert with the counts summed per queue.
  A lost lease, a repeat of the same lease and a result the store refuses fail alone; a failure of the transaction throws
  for all (the SDK's `#settle` retries once). The batch's rings ride on the first ok outcome. The worker option
  `groupComplete` (off by default, like `groupCommit`) gives each worker a `CompleteBatcher`: no timer, the first complete
  of an idle worker goes out in the same tick, later ones share the write in flight. `qcloud.worker.complete_group_size`
  records the batch size. **Metrics:** `recordMetrics` no longer deletes old buckets on every write; the tick does
  (`pruneMetricBuckets`, a probe per queue through the totals, plan-checked), and `throughput` clamps its range to the
  retention so a bucket the tick has not reached is not shown. Tests: 5 in `complete.many.test.ts`, 3 in
  `worker.groupComplete.test.ts`, one tick-prune test, one plan row; the model gained a `completeMany` command on Postgres
  and the fake store (31 pass at default and at 150 runs x 60 commands), and a deliberately broken token fence is caught
  (`I2.staleTokenRejected`). **Not measured:** the saving on a managed database (owed to the load check, F17).
  **Open decision:** `groupComplete` default-on, after that check. Not in `postgres-workers` model target.
- **R10** Three parts. (1) `Pump` (`workerPump.ts`): after a job ends and the last claim came back full, the worker claims again
  for its free slots without a bell, until a claim comes back short; on by default, `claimAgain: false` turns it off. It does not
  run after a run that wrote no outcome (`JobRun.wrote`), because a lost lease leaves a released job that must not be
  re-claimed at once (found by `worker.lease.test.ts`). (2) `ringCoverMs` (queue option, store option, off by default): an enqueue
  whose queue has a claimable job rung in the last `ringCoverMs` ms gets no bell and is stored as rung at that bell's time
  (`ringCover.ts`, one lateral probe per queue on `qcloud_jobs_ring_idx`, plan-checked); a delayed job keeps its ring. A covered
  job inherits its bell's age, so a stream of adds cannot hold the window open (found by the "window ends" test). Bounded by the
  tick's re-ring, like a lost bell: at most `reRingAfterMs` plus a tick interval for a consumer that never claims again.
  (3) `maxStaleRingsPerQueue` / `QCLOUD_TICK_MAX_STALE_RINGS_PER_QUEUE`: a separate cap for re-rings of jobs already rung, default
  the per-queue cap. **Model:** the `postgres-workers` target runs with `claimAgain: false` (a claim with no bell races the next
  command), and the model does not cover rings (cover breaks "deliverable bells >= claimable jobs" on purpose); 31 pass at the
  default and at a deeper run. Tests: 7 in `ring.cover.test.ts`, a stale-cap test, 3 in `worker.pump.test.ts`, a plan row.
  Also fixed: `webhook.receiver.test.ts` asserted exact retry waits and failed one run in three with R06's jitter; it now pins
  `random`. **Not measured:** the bells saved on a real queue (D9, F17). **Open decisions:** default-on `ringCoverMs` and a low
  default stale cap, after the load check. Emulator runs: contract (129 pass, 4 skip) and scenarios (106 pass, 2 skip) on
  local, Pub/Sub emulator and ElasticMQ.
- **R11** `payloadShape.ts` (`overShape`): an iterative walk of a value (values and object keys, Map/Set/array/object; Date, bytes
  and the like are one node) that stops at the first breach of `maxPayloadNodes` (default 20,000) or `maxPayloadDepth` (64).
  Applied to a job's `data` in `prepareOne` (so enqueue, flows and cron templates), to `updateData`, and to a completion's
  result (`encodeResult`). New `PayloadTooComplexError(kind, limit, index)`, exported, mapped to 413 `payload_too_large` with
  `kind`, `limit`, `index`. A cycle ends at the node cap and a value a million deep is refused without a stack overflow.
  Measured on msgpackr: 70 bytes of heap a value for empty objects and arrays (the worst), 8 for scalars, so a payload decodes
  to at most about 1.4 MB. Tests: 3 unit, 1 enqueue (also a million-null payload that fits the byte cap), 1 edit, 1 result,
  1 API mapping; `test:model` 31 pass; store, control-api, core, sdk and maintenance suites pass. **Not done:** the list route
  still decodes a whole page before it cuts each payload (a page of 500 worst-case jobs is about 700 MB), and stored rows are
  not rechecked; workflow rows keep their own larger cap. **Open decisions:** the number (the review said 250,000, about
  17 MB a payload) and a lazy list decode. F-2 is narrowed in the security review, threat model, limits and known issues.
- **R12** The artifact's ladder for F1 is batch, then spread namespaces, then replace the lock "if that is still short", after
  measuring commit time on the real instance. Step 1 was R02/R09 (`groupCommit`, `completeMany`, `groupComplete`); this task
  pins it with `journal.lockPasses.test.ts` (the commit sequence advances once per transaction: 50 single adds are 50 passes,
  one 50-job call 1; the same for `complete` and `completeMany`). Step 2 is R21. **Step 3 (a reader on the transaction-id
  horizon) is designed in `docs/spikes/07-journal-order.md` and not built:** it would let one job's events swap in a rare
  lock-order race, a long write transaction anywhere would stall every reader, it rewrites ported ordering code and the
  retention watermarks, and its premise (the commit time) needs a real-cloud measurement (D9, F17). **Open decision:** build
  it after the load check if 1 / commit time is below the target. No `test:model` run needed: no store code changed.
- **R13** Migration 13 adds `qcloud_deliveries`, partitioned by day on `created_at` (the event's time; PK and the event guard
  carry it), plus a default partition that takes a day with no partition (so a write never fails) and keeps the row-by-row
  retention with its own two indexes. `qcloud_ensure_delivery_partitions(now, ahead)` makes today and 3 days ahead by
  `CREATE TABLE ... LIKE` then `ATTACH PARTITION` (a day whose range the default already holds rows for is left there);
  `qcloud_drop_delivery_partitions(before)` drops a day whose end is past `before` and that holds nothing pending or sending.
  Both take `pg_advisory_xact_lock` and a 1 s `lock_timeout` (a pass that cannot lock stops and the next retries). The trigger
  writes the new table; live rows of the old table move over with their ids, the sequence continues, finished history stays
  behind. The tick's retention step calls both functions, then expires and deletes as before (the delete only on the default
  partition). New store setting `webhookKeepMs` (default 2 days, was a 7-day constant), `QCLOUD_WEBHOOK_KEEP_MS` in the tick.
  Tests: `webhook.partitions.test.ts` (7: ensure idempotent, default-held day skipped, day routing and whole-day drop, a live
  row blocks the drop, the tick makes and drops, the event guard, the migration move and id continuity); the plan tests map a
  partition's index to its parent and have two new rows; the snapshot reader skips dated partitions and prints the partition key.
  Store, maintenance and control-api suites 2,669 pass (TLS and PgBouncer skipped), `test:model` 31 pass, `docs:check` ok.
  **Not done / open:** the old table is dropped by a later release (a migration never drops what the previous release reads);
  **events are not partitioned** (retention is a cap per queue, readers need one ordered key). **Decisions to confirm:** the keep
  default of 2 days (the review asked for a setting; 7 days kept 3.5x the rows), retention counted from the end of the creation
  day, the shortest `webhookKeepMs` among ticks on one database decides. **Not measured:** the partition DDL's lock behaviour on
  Cloud SQL and RDS (scratch PostgreSQL 18.6 only; D9, F17); `ATTACH` also takes SHARE ROW EXCLUSIVE on `qcloud_webhooks` for the
  cloned foreign key, which holds up a webhook write for the instant it runs. Rolling back past 13 is in docs/operations.md.

- **R14** `qcloud-tick send` (`cli.ts`, `webhookLoop.ts`) is the sender as its own process: a pipelined loop that keeps
  `QCLOUD_WEBHOOK_CONCURRENCY` sends in flight, refills a slot as it frees and records finished ones in a batch, with a
  socket pool (`webhookPool.ts`, keep-alive keyed by address, port, TLS name and CA; kept only after a clean `HTTP/1.1` answer of
  known length; one retry on a new connection when a kept one fails before an answer byte), a name cache (`cachedResolver`,
  addresses only, every address still checked on every use) and a per-destination concurrency limit and circuit breaker
  (`webhookDestinations.ts`). Six options (`KEEPALIVE_MS`, `DNS_TTL_MS`, `PER_DESTINATION`, `BREAKER_FAILURES`,
  `BREAKER_COOLDOWN_MS`, `IDLE_MS`). Decision: a refused attempt (breaker open, destination busy) is recorded as a failed attempt,
  because the store has no way to hand a claim back and deferring would dodge the 24 h expiry; it costs a delivery one of its
  attempts. The tick's own sender step is unchanged (`postOverSocket` is now a pool with keep-alive off). Not built: a
  `workers` option, a backlog gauge for autoscaling and a Terraform sender service (R19), a health endpoint for `send`. Not
  measured: a real receiver's keep-alive and DNS behaviour, and throughput at volume (docs say so).

- **R15** Migration 14 adds `qcloud_webhook_writers` (a row means the writer, not the trigger, makes that namespace's deliveries),
  `filter` and `shape` JSONB and `active_from` on webhooks, and a nullable `body` on deliveries (null is the default body; `''` is a
  shaped body that was too large, which is recorded as failed and refused by the sender). `writeWebhookDeliveries`
  (`webhookWriter.ts`) reads the journal after its cursor with `readEventsOn`, matches enabled webhooks with `plan()`
  (`webhookPlan.ts`, the filter and the shape from core `webhookFilter.ts` and `webhookShape.ts`), inserts deliveries with
  `created_at = occurred_at` (so the day partition and the unique event index still dedupe) and moves the cursor, in one
  transaction under `FOR NO KEY UPDATE SKIP LOCKED`; a crash repeats a pass and nothing else. Switching on and off is lossless:
  `startWriter` begins at the journal's end, `stopWriter` marks `stopping` (the trigger delivers again), catches up, then locks the
  row `FOR UPDATE`, which waits for every job transaction that skipped its deliveries, drains and deletes it. A webhook with a filter
  or shape needs an active writer to be created, and stopping is refused while one exists. The shaped body is rendered once
  and stored, so every attempt sends and signs the same bytes; `X-Webhook-Schema: 1` goes out only with the default body. Shape
  keys come out shortest first, then alphabetical, so the preview equals the stored body (jsonb order). The writer pass runs in
  `qcloud-tick send` and in the tick's webhook step; `qcloud-tick webhook-writer on|off|status` switches it. Control API:
  `filter` and `shape` on create, `POST /webhooks/preview` (operator). Decisions: job `data` and results are NOT available to
  filters or shapes (the journal carries none; the review's "by opt-in" is skipped); a shaped body cannot hold the delivery id (the
  `X-Webhook-Id` header does); matching happens at write time, so a webhook change takes effect a few seconds late (`active_from`
  stops a re-enabled webhook from replaying the time it was off); after a journal gap (pruned events) those events make no
  deliveries (`webhooks.writer_gaps`); a retried oversize delivery is refused again; the "writer off" create refusal is 400
  `unsupported_option` for `writer`, not 409. Not built: a panel UI for filter, shape and preview. Not measured: writer throughput
  and lag at volume on a real database. Full gate on scratch PostgreSQL 18.6, SQS and Pub/Sub emulators: 5146 pass, 2 fail, neither
  from R15: `release.test.ts` (the LICENSE lost its Egeo Minotti line in commit 4103cee, as before this work) and the game-day
  `connections_high` drill, which needs the pool to hold 85% of `max_connections` and, with the scratch server at 300
  and a busy host, the pool opened only about 175 to 210 of 247 connections (a bare `Bun.SQL` probe shows the same); with
  `max_connections=200`, as in `docker-compose.test.yml`, it passes.
- **R16** Response capture: a failed attempt keeps the first 1 KB of the receiver's answer (`webhookHttp.ts` `readBody`, failed
  attempts only; a success keeps none), and every request carries a `User-Agent`. Migration 15 adds `consecutive_failures`,
  `alert_level`, `disabled_reason`, `disabled_at`, `secret_previous_sealed` and `secret_previous_until` to `qcloud_webhooks`, and
  the delivery trigger now fires for `enabled OR disabled_reason IS NOT NULL`. Auto-disable counts consecutive failed
  *deliveries* (every attempt used; a delivered one resets it; a pending retry does not count), decided on the final streak of a
  batch in `recordAttempts`; `webhookAlertLevel` gives 1 to 4 at 50, 70, 90 and 100 % of `QCLOUD_WEBHOOK_DISABLE_AFTER` (default 20,
  0 off), and level 4 pauses the webhook (`enabled=false`, `disabled_reason`, `disabled_at`). A paused webhook still collects
  deliveries (held, expire after 24 h); `setEnabled(true)` clears the pause, the streak and the level; a manual disable has no reason
  and is never a pause. Always-sign: a store with a `webhookKey` generates `whsec_` plus 64 hex when the spec has no secret and returns
  it once as `data.secret`; `rotateSecret` (`POST /webhooks/{id}/rotate-secret`, operator) moves the sealed secret to
  `secret_previous_*` for 24 h, the sender signs with both (comma-separated `v1=`), retention clears the expired one, rotating twice
  keeps only the latest two. Signals: wire fields, ops warnings `webhook_failing` and `webhook_paused`, gauge `webhooks.paused`.
  Decisions: default-on `disableAfter=20` and default-on response capture (off under dev mode unless set) are open for the owner;
  always-sign has no opt-out and existing unsigned webhooks stay unsigned until rotated; the generated secret in the create and
  rotate response is a deliberate exception to "no response carries the secret" (recorded in the threat model, A9); no
  `webhook.disabled` journal event and no email or pager alert; the panel's create form still makes its own secret (a blank form now
  gets a server-generated one the panel does not show) and has no rotate button; a paused webhook still costs the insert of each
  delivery for 24 h; rolling back past 15 leaves a paused webhook disabled (docs/operations.md). Not measured: real-receiver
  behaviour. Targeted runs on scratch PostgreSQL 18.6: control-api, maintenance and core 1209 pass after one test was rewritten for
  always-sign (`webhook.receiver.test.ts`).
- **R17** `qcloud-tick loop` runs the existing `TickLoop` as an always-on process: interval 1,000 ms, `maxStaleRingsPerQueue` 10 and the
  retention steps every 30 s, each unless the environment says otherwise. The lease, the scheduler as safety net and cron source, and
  the SIGTERM release are as before. New: `TickBudget.skipUpkeep` (the store leaves out retention, events and completions) and
  `upkeepEveryMs` / `QCLOUD_TICK_UPKEEP_EVERY_MS` (default 0, so `run`, `serve` and a `TickLoop` without it behave as before); the
  upkeep clock is per process, so a new leader runs the upkeep on its first beat. Not done: Terraform for the always-on loop (R19) and
  a health endpoint for the process. Not measured: the cost of a one-second beat on a real Cloud SQL or RDS instance. Targeted runs on
  scratch PostgreSQL 18.6: the maintenance package 397 pass, `tick.compose` 17 pass.
- **R18** A queue can be hot: its own Pub/Sub topic `qcloud.<ns>.hot.<queue>` and an unfiltered subscription of the same name, so its
  bells are delivered once instead of once per queue of the environment. The queue-to-topic map is `queueNames(ns, queue, hot)` in
  `names.ts`; the list is `hotQueues` / `QCLOUD_GCP_HOT_QUEUES`, and the Terraform `queues.<name>.hot` sets it on the API, the tick
  and the workers and grants the publishers. `ensureQueue` with `hot` refuses a subscription that is on the other topic. Decisions:
  the list is configuration, not discovered, so every process must be given the same one (a stale list rings the wrong topic until
  the tick re-rings); moving a live queue is `removeQueue` then `ensureQueue`, and Terraform replaces the subscription on a flip;
  the DLQ topic stays shared. Not done: a second project past about 5,000 queues; a check for a stale list; a real-cloud run (D9).
  Not measured: the cost and latency effect. Targeted runs on the Pub/Sub emulator and scratch PostgreSQL 18.6: transport-gcp,
  contract and transports 225 pass, 36 skip (SQS emulator down); `check:terraform` 172 + 827 + 128 + 2664 checks pass (plan only).
- **R19** Both examples take `tick_loop` and `webhook_sender` (fixed-count tasks of the tick image on the tick's identity, each holding a
  pool the budget counts) and `webhooks` (a `random_id` key in the secret manager, readable by the tick, loop, sender and control-plane API
  and by no worker). GCP also takes `database_edition` and `database_managed_pooling` (Cloud SQL's own transaction pooler, Enterprise Plus
  only, 50 server connections counted); AWS takes `database_cluster` (a Multi-AZ DB cluster in place of the instance, behind a `moved`
  block). Decisions: the sender is not autoscaled (nothing publishes a backlog); no missing-task alarm for the loop or sender, which are
  kept out of the "workers idle with backlog" alarm on purpose; the key lives in the state (back it up); cluster and proxy or Multi-AZ
  instance are refused; the loop and sender share the workers' database user. Not done: `terraform apply` and any real run (D9); not
  verified: Cloud SQL pool flags beyond the on switch, the cluster's instance class, storage, IOPS and CloudWatch dimension, a proxy
  in front of a cluster. `check:terraform` (plan only): GCP 202, AWS 860, GCP control plane 131, AWS control plane 2665 checks pass.
- **R20** `ResilientPool` refuses an operation when the process already has `maxInFlight` going (default 64 a connection of the pool,
  `ConnectionOptions.maxInFlight`): `StoreOverloadedError` (nothing was sent, safe to retry), mapped to 503 `store_overloaded`. The
  migrator clears `statement_timeout` for its own transaction. Terraform sets `statement_timeout` (30 s), `lock_timeout` and
  `idle_in_transaction_session_timeout` on the server (`database_session_timeouts`, both clouds, plan assertions in the four plan
  checks), because startup parameters are refused behind a transaction pooler. No metric-cap work was needed (no metric carries a
  queue tag; the rule is written in `docs/observability.md`). The panel rule "disable what cannot be done safely" is stated in the
  panel README. Nightly CI gained Firefox and WebKit jobs. Decisions: completions are not prioritised over claims; the limit is not
  env-tunable. Not done: the four alerts (worker slots, stuck jobs, failure rate, stale backup) are listed in `docs/observability.md`,
  not shipped; Firefox cannot launch under this sandbox, so no Firefox or WebKit spec has run anywhere and the nightly job has never
  run; the limit and the 30 s timeout were not measured under load (a tick pass or an obliterate may need longer); the three server
  flags were not applied to a cloud (D9). Regression run on scratch PostgreSQL 18.6: store-postgres, sdk, control-api and
  maintenance 3005 pass, 23 skip (PgBouncer, TLS), 0 fail; `check:terraform` 204 + 863 + 131 + 2665 checks pass (plan only).
- **R21** `ShardMap` (`store-postgres`) routes a namespace to a database: `QCLOUD_SHARDS=ns=shard,...` and
  `QCLOUD_SHARD_<NAME>_DATABASE_*` over the shared variables, explicit and never hashed, with a namespace outside the map
  refused. The SDK takes `shards`; the Control API picks its database from `QCLOUD_NAMESPACE` and `migrate` walks every shard,
  naming each; `QCLOUD_SHARD=a qcloud-tick loop` runs one `TickLoop` per namespace of the shard over one pool; the shard URLs are
  redacted from the tick's log. Decision D10 and the operator notes are in DESIGN.md, `limits.md` section 14 and `operations.md`.
  **Not done:** the Control API still serves one namespace per process (no request-time router: it needs the namespace in the
  URL, per-namespace authorization and panel changes); a namespace moves by hand (untested); no cross-shard reads; no Terraform
  for several databases; one namespace cannot be split; two schemas of one Postgres stood in for two databases, and nothing was
  measured under load. No migration, no core queue change (`test:model` not run). Regression on scratch PostgreSQL 18.6:
  store-postgres, sdk, control-api and maintenance 3021 pass, 23 skip (PgBouncer, TLS), 0 fail.
- **Final gate (after R21), scratch PostgreSQL 18.6, ElasticMQ 1.7.1 and the Pub/Sub emulator, `QCLOUD_REQUIRE_DB/SQS/PUBSUB=1`:**
  `typecheck`, `lint` (only the existing panel warnings), `format:check` and `architecture` pass; `bun test` 5205 pass, 29 skip
  (PgBouncer, TLS, real-cloud), **1 fail**: `test/docs/release.test.ts:21` (a package `LICENSE` still carries the Egeo Minotti
  line that the root `LICENSE` dropped in commit 4103cee; it failed before this work and was not touched, an owner decision).
  `test:model` 31 pass; `check:terraform` 204 + 863 + 131 + 2665 pass (plan only); `docs:check` passes. Not run: Docker, PostgreSQL
  16, PgBouncer, TLS Postgres, image scans, GitHub Actions, any real cloud (D9).

