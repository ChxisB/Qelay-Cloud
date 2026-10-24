# 08 — SDK: worker batch processing

**Status:** done · **Depends on:** 01 · **Touches:** packages/sdk, test/model
**Design:** none (reuses existing pages and parts)

## Goal
`new Worker(queue, handler, { batch: { size, maxWaitMs } })` calls the handler with up to `size` jobs at once.

## Steps
1. Read workerPump, workerClaim, jobRunner, groupComplete first. Decide where batches form: claim up to `size`, wait at most `maxWaitMs` for more after the first, run the handler once.
2. Handler gets `Job[]`; it returns nothing (all complete) or an array of the same length where an Error entry fails that job. A throw fails every job, each by its own attempts and backoff.
3. One lease renewal loop covers the batch; a job whose lease is lost is dropped from the result.
4. Complete with `completeMany`.
5. Option bounds: size 1..MAX_CLAIM; `batch` with `concurrency` > 1 means that many batches in parallel.

## Acceptance
- 25 waiting jobs and size 10 make three handler calls (10, 10, 5), after maxWaitMs for the last.
- A mixed result array completes some and fails others, each with its own error and attempts.
- A throw retries every job by its own backoff; a worker crash mid-batch leaves every job recoverable (stall).
- Without `batch` nothing changes (the existing worker suites pass). `bun run test:model` passes.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/sdk && bun run test:model
```

## Result
Done. `new Worker(queue, handler, { batch: { size, maxWaitMs } })` calls `handler(jobs, { signal })` with up to `size` jobs. Without `batch`
nothing changes (the 247 earlier SDK tests pass unchanged).

How it works: every claimed job still gets its own `JobRun` (lease, heartbeat, watchdog, attempts, backoff), and the processor each one calls is a
`BatchCollector.process`. It holds the job until `size` jobs are there or `maxWaitMs` has passed since the first, calls the handler once, and gives
each job its own outcome, so a mixed result, a throw, a lost lease and a release at close all go through the paths a single job takes. The handler
returns nothing (all complete) or one entry per job in order (an `Error` entry fails that job, `UnrecoverableError` fails it for good, anything else is its
result); a throw fails every job by its own attempts and backoff; a result that does not line up (wrong length, not an array) fails every job with a
message, because no job should be completed on a guess. `context.signal` aborts when every job's signal has aborted (lease lost for all, or the worker closed
out of its grace); a job aborted before its batch starts leaves it.

Decisions:
- `concurrency` counts batches at once. The worker holds `concurrency × size` jobs, a handler call that is due waits when `concurrency` calls are running,
  and the worker claims only when a whole batch of slots is free (`floor`), so jobs finishing one by one do not make one-job batches.
- The completes of a batch share one transaction through the existing `groupComplete` (`completeMany`) unless `groupComplete: false`. This is the
  one default that differs from a plain worker, and only for a batch worker.
- `close` runs a short batch at once, inside the grace, instead of waiting out `maxWaitMs`.
- Deviation from plan step 3 ("one lease renewal loop"): each job beats its own lease, because the store has no batched heartbeat and adding one is a
  `StateStore` change outside what was approved. A batch of 1,000 is 1,000 beats per third of the lease. Recorded as a `shortcut:` in `workerBatch.ts`;
  add a `heartbeatMany` when it shows in a profile.
- Types: the constructor has two overloads, `BatchProcessor` with `BatchWorkerOptions` and `Processor` with `JobWorkerOptions` (`batch?: undefined`), so a
  per-job handler with `batch` set is a compile error. Two test helpers that pass a spread `WorkerOptions` cast to `JobWorkerOptions`.

Changes: `packages/sdk/src/workerOptions.ts` (types, `batch` option and its checks, `groupComplete` default), `workerBatch.ts` (new: `BatchCollector`,
`planProcessing`), `worker.ts` (overloads, slots, floor, flush at close; 295 lines), `index.ts` (exports); `docs/compat.md` (`batch` is a `New` row);
generated `docs/unsupported.md` and `docs/reference/sdk-exports.md`. Tests: `worker.batch.test.ts` (10), `worker.batch.crash.test.ts` (1, SIGKILL in the middle
of a batch of 4: all four stall, are recovered with one attempt counted, and run as one batch), `crashWorker.ts` takes a batch size, `workerSupport.ts`
has `batchWorker`, `test/scenarios/stack.ts` casts.

Ran (Postgres 18 on 127.0.0.1:55442, `QCLOUD_REQUIRE_DB=1`): `bun test packages/sdk` 258 pass / 0 fail; `bun run test:model` 31 pass / 0 fail;
`bun run typecheck`, `bun run lint` (only the existing panel warnings), `bun run format:check`, `bun run architecture`, `bun run docs:check`. A removed
`flush()` makes the close test time out, so that test can fail.
Not run: the transport suites (a worker on Pub/Sub or SQS with `batch`; the batch collector is transport-blind and the bells are unchanged); a load
measurement of the heartbeat cost at size 1,000.
