# Production features: schedule, batch, DLQ retry, queue policy and window, importer (D15, D16, D17)

Plan: [.claude/.planning/production-features/CURRENT.md](../.planning/production-features/CURRENT.md), tasks 01 to 17, each with its
own Result. Requested and approved by the owner on 2026-10-23, after a review of what a Pub/Sub system loses when it moves here
(retries and a dead-letter queue, delays and backoff, latency and load, cutover) and a request for batching, a send time such as
midnight each night, and "the recommended and the best settings". Answers given the same day: schedule on gateway routes **and**
job queues; the batch body is an envelope; DLQ gets retry, a bounded bulk retry and retention, with no auto-retry; every gate
(two migrations, a `StateStore` change, new fields and routes in openapi, the panel) approved.

## What changed

- **Design record (01):** `DESIGN.md` D15 (route schedule and batch), D16 (DLQ retry **reopened**, auto-retry stays closed), D17
  (queue policy and run window). D16 reverses the Phase 0 closure of task 14 (k); the owner approved that.
- **Core (02):** `webhookBatch.ts` (limits, `batchId` as a SHA-256 of the sorted member ids, the envelope
  `{ batchId, count, events: [{ id, receivedAt, body }] }`), `webhookSchedule.ts` (cron and zone checks).
- **Migration 22 (03, 04):** `qcloud_webhooks.schedule_cron/schedule_timezone/batch_max_events/batch_max_bytes` and
  `qcloud_deliveries.batch_id`, all nullable. A delivery's due time is the first fire at or after request + `delayMs`. A cron that
  fires less often than every 31 days is refused. The 24-hour expiry counts from the due time, so a scheduled event is not expired
  while it waits.
- **Sender (05):** one claim takes one batch per route (up to `maxEvents` and `maxBytes`, an oversize event goes alone) and sends it
  as one signed request, `X-Webhook-Event: webhook.batch`. The batch is one attempt toward the claim limit and the per-minute rate. A
  2xx delivers every member; anything else fails all of them to one retry time; a member whose payload cannot be made fails alone.
- **Control API and openapi (06):** `schedule`, `batch` and the read-only `nextSendAt` on webhooks, `batchId` on deliveries and
  attempts.
- **Panel, routes (07):** Send, Time zone and Send-in-batches controls on a connection, "Scheduled" and "Batched" on its card.
- **SDK (08):** `new Worker(queue, handler, { batch: { size, maxWaitMs } })`. Every job keeps its own lease, heartbeat, attempts and
  backoff; the handler gets up to `size` jobs and returns one outcome per job.
- **DLQ (09, 10):** `StateStore.retryDlq` and `retryDlqMany` (fenced by the entry's version; refusals `not_found`, `not_failed`,
  `version`, `flow_member`, `duplicate`), `POST /queues/{q}/dlq/{jobId}/retry`, `POST /queues/{q}/dlq/retry` (typed
  confirmation, at most 500), `PUT /queues/{q}/dlq-config` for `maxAge` and `maxEntries`, SDK methods, Retry buttons in the panel.
  `autoRetry: true` stays 501.
- **Migration 23 (11, 12, 13):** `qcloud_queue_state.policy`, `run_window`, `window_from`, `window_until` and one partial index. A
  queue policy `{ attempts, backoff, timeout }` fills only what a job left out (`GET`/`PUT /queues/{q}/policy`). A run window
  `{ cron, durationMs, timezone }` makes a claim return nothing outside it; the tick moves the window on and no bell is spent on a
  closed queue. A pause still wins.
- **Panel, queue (14):** Retry policy and Run window cards on the queue page.
- **Importer (15):** `qcloud-import-pubsub` in `packages/transport-gcp` (jobId = Pub/Sub messageId, ack after the commit), runbook
  `docs/runbooks/import-from-pubsub.md`. Emulator only unless `QCLOUD_REAL_CLOUD=1`.
- **Production settings (16):** `docs/production.md` and three Deployment warnings (`schedule_without_sender`,
  `window_without_tick`, `delay_finer_than_tick`); the Control API now reads `QCLOUD_TICK_INTERVAL_MS`.
- **Docs (17):** `operations`, `compat`, `unsupported`, `concepts`, `migration`, `limits`, `webhooks`, `event-gateway`, the
  `tick-stopped` and `dead-letter-queue-growing` runbooks, the README and four quickstarts. The full test run showed that the
  dead-letter runbook, `migration.md`, a `compat.md` row and the control-api README still said DLQ retry is not supported; fixed.

The working tree is 305 files changed against HEAD (5,890 added, 4,558 removed) and 171 untracked files. That count includes the
earlier inbound-sources work ([note](2026-10-23-inbound-sources.md)), which is also uncommitted. Nothing is committed.

## What ran, and against what

Local PostgreSQL 18 (Homebrew, `127.0.0.1:55442`, `QCLOUD_REQUIRE_DB=1`) and the Pub/Sub emulator (`127.0.0.1:58085`,
`QCLOUD_REQUIRE_PUBSUB=1`). Docker was not used.

- `typecheck`, `lint` (0 errors, panel warnings only), `format:check`, `architecture`, `docs:check` (7 documented blocks run),
  `docs:transports`, `security:routes --check`: pass.
- `bun test`, whole repo: **6,425 pass, 151 skip, 1 todo, 2 fail** (6,579 tests, 683 files, 1,153 s). The failures:
  1. `test/gameday/workers.test.ts`, "jobs failing for good": it asserted `POST /queues/jobs/dlq/retry` is 501. **Fixed**: it now
     asserts a call without `confirm` is 400 and retries the four failed jobs through the route. It passes (3 of 3).
  2. `test/docs/release.test.ts`, "package metadata ... carries a licence file": the per-package `LICENSE` files still carry
     `Copyright (c) 2024 Egeo Minotti` and the root `LICENSE` dropped it in 4103cee. The package files are unchanged by this work, so
     it fails at HEAD too. **Not fixed, the owner's call.**
  Re-run after the fixes: `test/docs` and `test/gameday` 39 pass, 1 fail (the licence test).
- `bun run test:model`: 31 pass. Run because the claim path, the DLQ and enqueue changed.
- `bun run --cwd packages/panel build` and `bun test packages/panel`: 2,204 pass, 0 fail.
- **e2e, Chromium only:** Playwright wants `chromium_headless_shell-1234`, which is not installed (the cache holds 1243 and 1248). I
  ran the Chromium project through a temporary config that points at the cached 1248 build (deleted afterwards): **34 pass, 1
  fail**, the stale `e2e/webhooks.e2e.ts` (it looks for a `/webhooks` link, and that path has redirected to `/events-gateway`
  since before this work). Not fixed: it needs a rewrite for the gateway pages. No e2e spec visits the new queue cards, the Send
  and batch controls or the DLQ Retry buttons, so the axe scan in `e2e/fixtures.ts` did not cover them.
- Per task, each Result lists its own runs (store, sender, control-api, sdk, transport-gcp against the emulator with 250 messages and
  a crash between add and ack).

## Not run, or owed

- Any real cloud (D9). Nothing here has met a real Pub/Sub subscription, SQS queue, load balancer or managed database.
- The SQS emulator (ElasticMQ was not running): no `batch` or run-window suite ran against SQS. PgBouncer and TLS connection suites.
- Docker, Firefox, WebKit. `check:terraform` (nothing under `infra/` changed).
- An independent security review. The routes are operator-only, audited, and log no payload, but that is my own reading.
- Accessibility: no `accessibility-scan` or keyboard check of the new panel cards and forms, no look at light theme or phone width.
- Measurements: the worker-batch heartbeat cost for a large `size` (task 08), the precision of a run window's opening, and the
  sender's batch throughput. The figures in `docs/production.md` marked **derived** or **chosen** are not measurements.
- The importer through `QCLOUD_DATABASE_URL` (only the injected-store path is tested).

## Decisions and limits to confirm

- **Licence line** (above): drop the upstream line from the package `LICENSE` files, or restore it to the root. Ported code needs
  the upstream notice either way (CLAUDE.md).
- **Rolling deploys.** Migrations 22 and 23 only add nullable columns, so an older release keeps working, but it ignores them: an
  older tick sends a scheduled or batched event singly and at once, and an older worker claims inside a closed window. Add schedules
  and windows only after every process runs this release. `docs/operations.md` says so and covers rolling back past 22 and 23.
- **One batch per route per claim.** On the scheduler alone (a tick a minute) a batch route sends 100 events a minute at the
  default; a route that gathers a whole night needs a tick that runs often or `qcloud-tick send` as its own process.
- **Expired scheduled events.** An event still unsent 24 hours after its fire is marked `failed` with `expired`; a fire that finds
  the sender stopped for a day loses that night's events.
- **Deployment warnings cannot see everything.** A sender switched off with `QCLOUD_WEBHOOK_BATCH=0` is not detectable; closed
  windows are counted only for queues with pending jobs; the cron period is not compared with the tick interval. Example codes at
  `docs/openapi.yaml` (the warnings list) were not extended.
- **A test delivery on a batch route** ("Send test event") is claimed as a batch member. No test covers it.
- **Importer limit.** A message delivered again after its job already finished adds a new job, so it runs twice. It needs a crash
  and a worker finishing the job inside one ack deadline; pause the queue while importing when that is not safe.
