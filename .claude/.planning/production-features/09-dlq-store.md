# 09 — Store: DLQ retry, fenced

**Status:** done · **Depends on:** 01 · **Touches:** packages/core/src/store.ts, packages/store-postgres/src/store/dlq.ts, test/model
**Design:** none (reuses existing pages and parts)

## Goal
`StateStore.retryDlq` puts a dead-lettered job back to waiting, once, guarded by its version.

## Steps
1. Read dlq.ts, retry.ts, fail.ts and the entry/version columns first. Interface: `retryDlq(queue, jobId, { expectedVersion })` and a bounded `retryDlqMany(queue, { limit <= 500, filter })`.
2. One transaction: lock the DLQ entry and job row, check the version, move the job to waiting with attempts reset (keep its history), delete the entry, journal a `retried` event, ring after commit.
3. Idempotent fence: a second retry of the same entry, or a retry racing a purge, changes nothing and says so.
4. The model harness gains the command; the transition rules in core allow failed/dlq to waiting only through this path.

## Acceptance
- A retry returns the job to waiting; a worker runs it; the entry is gone.
- A stale expectedVersion, a missing entry or a double retry change nothing and return a typed reason.
- Retry racing purge: exactly one wins (a two-connection test).
- `retryDlqMany` stops at the limit and reports the remainder.
- test:model passes with the new command.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/store-postgres packages/core && bun run test:model
```

## Result
**Done.** Run on scratch Postgres 18 (127.0.0.1:55442), no Docker, no cloud.

- `StateStore.retryDlq(queue, jobId, { expectedVersion? })` and `retryDlqMany(queue, { limit 1..500, reason? })`, with the types
  in `packages/core/src/dlqRetry.ts` (moved out of `jobs.ts`, which is back under 300 lines) and the store in
  `packages/store-postgres/src/store/dlqRetry.ts`.
- One transaction per call: lock the job row, check the version, move it to waiting with attempts reset (the attempt history is
  kept), delete the DLQ entry, journal the event, ring after commit. A bulk call takes the oldest failures first and reports
  `retried`, `remaining` and the rings.
- A refusal is an answer, not an error, and changes nothing: `not_found`, `not_failed`, `version`, `flow_member`, `duplicate`.
- Tests: `dlq.retry.test.ts` (14: retry then a worker runs it, stale version, missing entry, double retry, retry racing purge on
  two connections with exactly one winner, bulk stops at the limit and reports the rest, reason filter, flow member, dedup
  clash); the model harness has a `retryDlq` command (`test/model/commands-dlq.ts`).
- Ran: `QCLOUD_REQUIRE_DB=1 bun test packages/store-postgres packages/core` 2096 pass / 22 skip / 0 fail (the skips are the
  PgBouncer, TLS and similar opt-in suites); `bun run test:model` 31 pass.
- Known limits, kept on purpose:
  - `duplicate`: a live job with the same dedup key stops the retry, so the entry stays and the caller is told why.
  - Attempt numbers repeat after a retry, because the history is kept and the counter restarts.
  - A job with `parent_id` set is a flow member even if the parent is gone; its way back is the flow's `retry-failed`.
  - A retried job still has its original TTL and can expire.
  - A dedup race between a retry and a concurrent enqueue can surface as the driver's unique violation rather than `duplicate`.
- Not run: the Pub/Sub and SQS transport suites against the new rings (a retry rings like an enqueue and adds no transport path).
