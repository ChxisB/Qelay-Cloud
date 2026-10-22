# 09 — The queue destination: "when A happens, do B"

**Status:** done · **Depends on:** 08 · **Touches:** packages/core, packages/store-postgres, packages/maintenance

## Goal
A delivery to a `queue` destination adds a job in the same database, with no network. Loops are already refused on save (08).

## Steps
1. In the tick's sender, branch on `destination`: `http` is today's path unchanged; `queue` calls the store's enqueue with a
   custom job id made from the delivery id, `qcloud-route-<deliveryId>` (a repeated attempt finds that job and makes no second
   one; a dedup key was not used because it only holds while the first job is still there). The job gets no bell from the
   sender: the tick's ring pass rings it, as for a cron's job. `data` is the body the route's `shape`
   renders, `name` is the event's name.
2. The attempt is recorded like any other (a delivered attempt with no status code). The store keeps no response on a success,
   by design and by an existing test, so the job is named from the delivery instead: core's `routeJobId(deliveryId)`.
3. Tests on the real store: A completes then B is enqueued once; a crash after enqueue and before the record makes no
   second job; a chain of two routes runs end to end; an `http` route behaves exactly as before.

## Acceptance
- Each test above passes on Postgres; the existing webhook sender suites pass unedited.
- Enqueue honours queue limits and pause (an enqueue refused is a failed attempt that retries on the webhook schedule).

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/maintenance packages/store-postgres packages/core
bun run test:model
```

## Risks / notes
- `test:model` runs because a job can now be created by a delivery; the model harness is the check that queue semantics hold.
- A route on `job.pushed` that enqueues into the same queue is the obvious foot-gun: the save check in 08 refuses it.
- "Start a workflow" is this route plus a worker that calls `startWorkflow` (D11); the engine is untouched.

## Result

Done 2026-10-21.

**What changed**
- `store-postgres`: a claimed delivery carries `destination`, `target` and `url` (empty for a `queue` route): `webhookTypes.ts`,
  `webhookClaim.ts` (the claim's SQL reads the two columns). `webhookRecord.ts` is unchanged: a success still keeps no response.
- `core`: `routeJobId(deliveryId)` = `qcloud-route-<deliveryId>` in `webhookRoute.ts`.
- `maintenance`: `webhookEnqueue.ts` (new), a `queue` branch at the top of `sendDelivery`, `SendDeps.enqueue`, and
  `sendDueWebhooks` and `runWebhookLoop` pass `store.enqueue`. A store refusal is a failed attempt that retries on the route's
  schedule; a sender with no `enqueue` (one built before D11) fails the attempt without adding a job.
- Tests: `webhook.enqueue.test.ts` (7, no database) and `webhook.queue.db.test.ts` (5, Postgres): A then B once with no request
  made, a crash after the job was added makes no second job, a chain A to B to C, a refused enqueue retries then succeeds, an
  `http` route beside a `queue` route.

**Decisions**
- A custom job id, not a dedup key: a dedup key only holds while the first job exists.
- The sender does not ring the new job. The tick's ring pass rings a ready job nobody rang, as for a cron's job.
- The history of a delivered queue attempt has no job id (the store keeps no success response, and a store test pins that). The
  id is derivable, so task 10 can put it on the delivery wire and task 11 can link it.

**Ran** (local Homebrew Postgres 18 on :55442, `QCLOUD_REQUIRE_DB=1`)
- `bun test packages/maintenance packages/store-postgres packages/core packages/control-api`: 2964 pass, 23 skip, 1 fail before
  the `webhookRecord` revert (the store test that pins "a success keeps none"); after the revert, the three-package rerun had
  2296 pass, 1 fail, below.
- `bun run test:model`: 31 pass, 0 fail.
- `typecheck` passes, `format` applied.

**Not run, or open**
- The one remaining failure is `read.plans.aux.test.ts` "throughput of the whole fourteen days" (the planner picked a bitmap scan
  plus a Sort): it passed in 2 of 3 isolated reruns and in the first full run. The file and the query are untouched here and
  read the job-event throughput tables, not webhooks. Treat it as a flake to confirm at the gate; it is not shown to be caused
  by this task.
- Docker, PgBouncer, TLS, Pub/Sub and ElasticMQ suites (skipped); no real cloud.
