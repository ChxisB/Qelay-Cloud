# Production features (P1 to P7)

Requested and approved by the owner on 2026-10-23, after a review of what changes when a Pub/Sub system moves here:
"add all the missing ... for batch send, a time of when the events send like midnight each night for a queue ... the
recommended and the best settings, most production ready features". Answers given the same day:

- Schedule applies to **gateway routes and job queues**.
- A batch request is an **envelope**: `{ batchId, count, events: [{ id, receivedAt, body }] }`.
- DLQ: **retry one, retry a bounded set, set retention through the API; no auto-retry**.
- Gates **approved now**: two migrations, the `StateStore` change for DLQ retry, new fields on existing openapi routes and new
  routes, the panel. No new dependency, nothing under `infra/`.

## Goal
A system that moves from Pub/Sub keeps what it had: retry policy per queue, a DLQ it can replay, sends that go at a set time
(nightly), many events per request, many jobs per handler call, and a way to move the old messages over.

## Scope
- **In:**
  - P1 gateway send schedule (cron + time zone) for any route.
  - P2 gateway batch send (HTTP routes).
  - P3 worker batch processing (`batch: { size, maxWaitMs }`).
  - P4 DLQ retry (one, bounded set), retention through the API.
  - P5 per-queue retry policy stored on the server.
  - P6 job-queue run window (workers claim only inside set hours).
  - P7 Pub/Sub importer and cutover runbook (emulator only), production settings guide, deployment warnings.
- **Out:** DLQ auto-retry (retry storms); batches for `queue` routes (a job is already one item); delivery groups; a partial
  success answer from a receiver (a batch is delivered or retried as a whole); an SQS importer; turning `groupCommit` or
  `groupComplete` on by default (core queue semantics, decided off).
- **Still the owner's:** commit, push, publish, version bump; any real cloud write or run (D9, so the importer is emulator-only
  here); `terraform apply`.

## Touches
`packages/core`, `packages/store-postgres` (migrations 22 and 23, schema snapshot), `packages/sdk`, `packages/maintenance`
(sender, tick), `packages/control-api` (routes, openapi, audit), `packages/transport-gcp` (importer), `packages/panel`, docs.
Core queue semantics change (P3, P4, P6), so `bun run test:model` runs and the model gains the new commands.

## Design impact
Adds D15 (send schedule and batch), D16 (DLQ retry reopened) and D17 (queue policy and run window) to DESIGN.md. D16
**reverses** the Phase 0 closure of task 14 (k); the owner approved that on 2026-10-23. Nothing a previous release reads or
writes is removed or retyped: columns are added, nullable or defaulted.

## Risks
- A scheduled delivery can wait up to a day; the 24-hour delivery expiry must not fail it (task 04 reads it first).
- Batch: one request carries many deliveries, so the per-route rate limit, the claim lease and the retry jitter each need a
  rule per batch, not per delivery (task 05).
- Run window adds a check to the claim path; it must cost two integer comparisons and nothing for a queue with no window.
- DLQ retry needs the entry fence: a job retried twice, or retried while a purge runs, must not run twice.
- Old workers and ticks ignore the new columns: a route with a schedule or batch must be added after every tick runs this
  release (the note D13 gave for delay and dedupe).

## Status
| # | Mini-task | Depends on | Status |
|---|-----------|-----------|--------|
| 01 | [design decisions](01-design-decisions.md) | — | done |
| 02 | [core rules and batch body](02-core-rules.md) | 01 | done |
| 03 | [migration 22: route schedule and batch](03-migration-22.md) | 02 | done |
| 04 | [store: schedule and batch fields, due time](04-store-schedule.md) | 03 | done |
| 05 | [sender: batch claim, one request, record](05-sender-batch.md) | 04 | done |
| 06 | [control api and openapi: route fields](06-api-route-fields.md) | 05 | done |
| 07 | [panel: schedule and batch on a connection](07-panel-route-fields.md) | 06 | done |
| 08 | [sdk: worker batch processing](08-worker-batch.md) | 01 | done |
| 09 | [store: DLQ retry, fenced](09-dlq-store.md) | 01 | done |
| 10 | [api, panel: DLQ retry and retention](10-dlq-api-panel.md) | 09 | done |
| 11 | [migration 23: queue policy and run window](11-migration-23.md) | 01 | done |
| 12 | [queue retry policy](12-queue-policy.md) | 11 | done |
| 13 | [queue run window](13-run-window.md) | 11 | done |
| 14 | [panel: queue policy and window](14-panel-queue.md) | 12, 13 | done |
| 15 | [Pub/Sub importer and runbook](15-pubsub-importer.md) | 12 | done |
| 16 | [production settings and warnings](16-production-settings.md) | 14 | done |
| 17 | [docs, gate, hand-off](17-docs-gate-handoff.md) | 07, 08, 10, 15, 16 | done |

## Result
Done 2026-10-24. All 17 tasks are built and nothing is committed. Gate: static checks pass; `bun test` 6,425 pass, 2 fail, of which
one (the game-day DLQ retry assertion) was fixed and one (the per-package `LICENSE` text) fails at HEAD too and is the owner's call.
Details, what did not run and the open decisions are in `.claude/completions/2026-10-23-production-features.md`.
