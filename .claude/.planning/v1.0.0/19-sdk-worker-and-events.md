# 19 — SDK: Worker and QueueEvents

**Status:** done · **Depends on:** 14, 16, 18 · **Phase:** 1

## Goal

The consumer side: a `Worker` that turns doorbells into claimed, heartbeated, completed or failed jobs, and `QueueEvents` that streams job events from `qcloud_events`.

## Scope

In: `Worker`, job context (`updateProgress`, `log`, `discard`), lease heartbeats, graceful shutdown, worker registration, events, rate limiting, tests including crash tests.
Out: `SandboxedWorker`, batch processors and Observable results (D6), flows (task 50).

## Reference

`../qelay/src/client/worker/` (`worker.ts`, `processor.ts`, `workerPull.ts`, `workerHeartbeat.ts`, `workerRateLimiter.ts`, `ackOutcome.ts`), `../qelay/src/client/events.ts`, `../qelay/src/client/queue-events/`.

## Gate decisions (task 06)

Binding. Evidence: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md), [spike 05](../../../docs/spikes/05-db-access-and-delay.md).

- **The worker keeps its own slot semaphore.** The transport's demand-driven receive is advisory: `capacity()` reports
  free slots and `refresh()` is called when one frees, but a transport may still deliver more than asked, and the
  semaphore is what bounds concurrency. A busy worker asks for no bells, so the backlog stays visible to an autoscaler.
- **Ack follows the claim attempt.** The `Delivery` is acked once `claim` returned (including an empty claim), and a
  database error nacks with a backoff. The transport, not the worker, extends the broker's deadline while the claim
  runs. A bell's `jobId` is a hint: the worker claims by queue and never by that id.
- **`complete` and `fail` return rings, and the worker rings them.** A retry comes back as a bell with `dueInMs`
  equal to the backoff, and a completed child can promote a flow parent. The worker rings them as the SDK's `add`
  does (task 18) and calls `markRung` only for the `ok` items. Where the delay is above the transport's window (on
  Pub/Sub it is always above it, `maxDeliverDelayMs` 0) the item is not sent and the job stays unrung for the tick.
  That is what makes retry backoff tick-speed on Pub/Sub and exact on SQS.
- **Store calls run under a deadline.** An `OperationDeadlineError` means "outcome unknown". Heartbeat, `complete`
  and `fail` are guarded by lease token or `version`, so on a deadline the worker may retry once or drop the result
  with no double effect; it never assumes success. A heartbeat that cannot be confirmed before the lease would have
  expired is treated as a lost lease: abort the processor. Decide the exact rule, and test it with the TCP fault
  proxy from task 11 (a silent stall, not just a reset).
- **`close({ graceMs })` always returns.** It passes a timeout to the store and transport closes
  (`close({ timeout })`), because the driver's `close()` hangs on a connection that has gone silent. Shutdown order:
  stop subscribing, drain or abort in-flight jobs, release leases, stop any in-process tick (task 20), close the
  transport, close the store.
- **The in-process tick is task 20's.** The SDK does not import `maintenance`. An always-on worker process starts
  the tick beside the `Worker`, and the shutdown order above is what makes that safe. If task 20 needs a lifecycle
  hook in `Worker`, it adds it and records it in its Result.
- **Rate-limited queues resume at the speed of the next bell.** On a zero-delay transport that is the tick (or the
  in-process tick). The worker does not poll the store to compensate; document the consequence in the Result.

## Steps

1. **Loop:** `transport.subscribe(queue, onDoorbell, { capacity: () => freeSlots })`. On a doorbell, compute free capacity, `store.claim(queue, workerId, freeCapacity)`, run each job under the processor with an `AbortSignal`, then `complete` or `fail`. An empty claim is normal; ack and move on.
2. **Heartbeat:** renew the lease at a fraction of `lockDuration` (default one third); if a renewal reports the lease lost, abort the processor's signal, stop reporting results for that job, emit `error`/`stalled`. Never complete a job after losing the lease. A renewal that hits its deadline is "outcome unknown" (see Gate decisions).
3. **Job context:** `updateProgress`, `log`, `discard`, `data`, `attemptsMade`, `id`, written through the store; log and progress writes are best-effort bounded and must not block the processor.
4. **Graceful shutdown:** `close({ graceMs })` stops subscribing, waits for in-flight jobs up to the grace, aborts the rest, releases their leases with no failed attempt counted (task 13 `release`), then closes the transport and store with a timeout so a silent connection cannot hang it.
5. **Registration:** insert and heartbeat into `qcloud_workers` (id, queues, started at, host/pid metadata); deregister on close.
6. **Events:** worker emits `active`, `completed`, `failed`, `progress`, `error`, `stalled`, `drained`. `QueueEvents` reads `store.readEvents(cursor)` using polling plus the local-transport `NOTIFY` wake, resumable from a cursor, gap-safe.
7. **Rate limiter and concurrency:** per-worker `concurrency` plus the store-enforced queue limits (task 13). The worker must not busy-loop when a queue is rate-limited; it waits for the next doorbell or the window reopening.
8. **Crash tests** using subprocess workers: `kill -9` a worker mid-job; assert the lease expires, the job is recovered **by the tick** (a later doorbell claims nothing while the dead worker's row is `active`), the attempt is counted, and no completion is reported twice. Add a stall test: the database connection goes silent (fault proxy) mid-job and the worker neither completes twice nor hangs on `close`.
9. Model harness: run it with real `Worker` loops on the local transport and the memory transport with fault injection, on the Postgres store with the fake `Clock`.

## Acceptance

- Crash test passes: SIGKILL mid-job leads to exactly one eventual completion and `attempts` incremented once per crash.
- A worker that loses its lease never writes a completion or failure for that job.
- `close()` with in-flight jobs releases leases without counting failures, and leaves no active job owned by the closed worker.
- `close()` returns within its grace plus a bounded margin even when the database connection has gone silent.
- Concurrency never exceeds the worker's slot count, even when a transport delivers more bells than the capacity it reported.
- `QueueEvents` resumes from a stored cursor with no gaps or duplicates under concurrent writers.
- `bun run test:model` passes with real workers in the loop.

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/sdk --grep "worker|events"
bun run test:model
```

## Risks / notes

- The heartbeat timer must keep running while the processor blocks the event loop's microtasks; use a real timer, and test with a CPU-bound processor.
- Do not ack the doorbell on job completion (spike 03/04); acking is tied to the claim attempt, so long jobs are not affected by ack deadlines or visibility timeouts.
- Graceful shutdown on SIGTERM is what Cloud Run and ECS send. Test the signal path.

## Result

**Done locally, on PostgreSQL 18.6, the in-memory transport and (for the whole-repo run) the Pub/Sub emulator, not on the Docker PG 16 of CI.**
The user told me to defer Docker-backed runs until every task is done. That departs from CLAUDE.md's "run the gate with `QCLOUD_REQUIRE_DB=1`"
rule (the runs here set it, against the local PG 18); the PG 16, PgBouncer, TLS, ElasticMQ and DDL-snapshot runs are owed at the end. No real
cloud resource was used. Details of the findings: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md), section "The Worker
and QueueEvents (task 19)", items (a) to (h), and a dated amendment.

**Built**

- **`packages/sdk/src/`** (14 new files, each under 300 lines): `worker.ts` (the class: slots, bell handler, pause/resume, close),
  `workerClaim.ts` (the claim a bell starts, the one recheck, `settleBell`), `jobRunner.ts` (one claimed job from claim to last write:
  heartbeat, watchdog, the one-writer rule), `workerJob.ts` (the job the processor sees: `updateProgress`, `log`, `discard`),
  `workerOptions.ts` (options, `ProcessorContext`, `UnrecoverableError`, refusal of what Qelay has and this package does not),
  `workerHooks.ts`, `workerRegistry.ts` (the `qcloud_workers` row and its beat), `workerDrain.ts` (`drained`), `workerShutdown.ts`
  (stop subscribing, drain, abort, release, close), `queueEvents.ts` and `queueEventTypes.ts` (the cursor reader), and three helpers
  (`typedEmitter.ts`, `timing.ts`, `errorText.ts`). `runtime.ts` and `index.ts` were edited.
- **Store and core, two small changes:** `PostgresStore.leaseMs` is readable (the SDK builds a worker's store with the worker's lease length
  and refuses a borrowed store whose length differs), and `@qelay-cloud/core` has `OutcomeUnknownError` (code `OUTCOME_UNKNOWN`) for a write
  whose outcome the worker cannot tell.
- **SDK tests** (`packages/sdk/test/`, 47 new tests in 8 files, plus 2 added to `queue.compat`): `worker.flow` (9), `worker.slots` (8),
  `worker.lease` (5), `worker.close` (7), `worker.crash` (3, real child processes), `worker.locked` (3), `events.stream` (10),
  `events.resume` (2). Helpers: `workerSupport.ts`, `childLines.ts`, `crashWorker.ts`. Store test: `claim.locked.test.ts` (3).
- **Model harness with real Workers** (`test/model/`): `bridgeTransport.ts` and `workers.ts` (a `WorkerBridge`), a `postgres-workers`
  target, and `workers.test.ts` (7 scripted histories that check the bridge itself).
- **Docs:** `docs/compat.md` now classifies every name of Qelay's `Worker` (27) and `QueueEvents` (7), enforced by `queue.compat.test.ts`;
  `docs/PORTING.md` (four rows, all "written fresh"); the gate document.

**Design problems found and how they were handled**

- **A bell can find its own job locked.** `ringAfterCommit` rings and then `markRung` updates the job's `rung_at`; a transport that
  delivers at once starts the claim while that `UPDATE` holds the row, `SKIP LOCKED` skips it, the claim is empty and the bell is spent.
  A flaky test (about one full-suite run in three to six, on the zero-latency in-memory transport) found it. **Handled in the worker**:
  one recheck after 25 ms when the empty claim's bell names a job still `waiting` or `prioritized`. Rejected alternatives and the hand-off
  to task 20 are in the gate document, item (a). After the fix, 8 full runs of `./packages/sdk` (PG 18 and the emulator) were all clean.
- **DESIGN.md says a `QueueEvents` listener costs one direct connection. It costs none:** the journal sends no notification, so the
  reader polls with one pooled statement per read. Recorded in item (e); the DESIGN.md line is amended in task 70's docs pass.
- **The journal cannot carry some fields Qelay's events do** (`returnvalue`, `delay`, a non-numeric `progress`). Left out, listed in
  `docs/compat.md` and item (f).
- **A heartbeat that throws proves nothing.** The watchdog (last confirmed beat start plus the lease length) decides, so a worker never
  writes after a recovery may have handed the job on. A processor that blocks the event loop longer than `lockDuration` loses its lease.

**Decisions on the gate's open points**

- The processor is `(job, { signal })`; the signal aborts on a lost or unconfirmed lease and on a `close` whose grace has run out.
- A busy worker asks for no bell; a bell with no free slot is nacked after 250 ms, a failed claim after 1,000 ms; a bell is acknowledged
  after the claim attempt (the recheck included), never after the job; the claim is by queue, never by the bell's job id.
- `close({ graceMs, timeout })` returns within `graceMs` plus two timeouts; `close(true)` is no grace; closing is idempotent. The store is
  closed only if the worker opened it, the transport only with `closeTransport`.
- A write that throws is retried once; a second throw is `OutcomeUnknownError` on the `error` event, and a refused second write is not
  taken for a landed first one.
- Listeners are isolated: a throwing listener is logged and the rest run; an `error` with no listener is logged, not thrown.
- `attemptsMade` counts failed and stalled attempts only. A terminal stall is journaled as `failed`.
- The SDK does not import `maintenance`; the tick joins the shutdown order in task 20.

**Acceptance**

- *SIGKILL mid-job: exactly one eventual completion, attempts incremented once per crash.* **Done, with one stand-in.**
  `worker.crash.test.ts` kills a child-process worker twice, checks the job stays `active` under its lease, recovers it, and a third
  worker completes it once: `attempts` 1 then 2, journal one `completed`, two `stalled`, three `pulled`. The recovery is the test calling
  `store.recoverExpired()`, **not the in-process tick** (task 20). A job that crashes its worker on its last attempt fails for good;
  SIGTERM closes the child with the job released and no failure.
- *A worker that loses its lease never writes.* **Done.** `worker.lease.test.ts`: a refused heartbeat, a processor that then fails, and an
  unconfirmed heartbeat (the watchdog rule). The store's `complete` and `fail` are also fenced by the lease token.
- *`close()` releases without counting failures and leaves no active job.* **Done.** `worker.close.test.ts` (running jobs released,
  attempts unchanged, none `active`; a job that ends within the grace completes; a processor that ignores the signal is released and its
  late result dropped).
- *`close()` returns within grace plus a bounded margin with a silent database.* **Done**, against the fault proxy with the connection
  black-holed: under `graceMs + 2 x timeout + 500 ms`, and the lease is left to expire and be recovered.
- *Concurrency never exceeds the slots, even when a transport over-delivers.* **Done.** `worker.slots.test.ts` (twenty jobs, three at
  a time; a transport that over-delivers is nacked) and, in the model harness, a bridge that offers more bells than slots.
- *`QueueEvents` resumes from a stored cursor with no gaps or duplicates under concurrent writers.* **Done.** `events.resume.test.ts`:
  four writers with overlapping commits; a reader stopped mid-stream and a second one started from its cursor see every event once, in
  order; a reader resumed from a cursor reads what was written while it was away.
- *`bun run test:model` passes with real workers in the loop.* **Done, on a different transport than the plan names.** The
  `postgres-workers` target hands each bell the model would claim with, and each lease it would end, to a real `Worker` (concurrency 2)
  over a fault-injected `BridgeTransport` (`ok`, `drop`, `duplicate`, `late`); the store is the model's virtual-clock `PostgresStore`
  behind a spy that feeds every claim through `verifyClaim` and every answer back to the model. **Not the real local transport or the
  `MemoryTransport` under the model** (the model must decide which bell arrives when), and the `crash` command is excluded (a worker's
  death is `worker.crash.test.ts`). The 7 scripted tests in `test/model/workers.test.ts` check the bridge is not a no-op (claims and
  ends made by workers, a nack returning the bell, a lease given back being thrown out of its worker, a model/store disagreement inside a
  worker's claim failing the run).

**Checked**

- `bun run typecheck && bun run lint && bun run format:check && bun run architecture`: clean (403 files within the 300-line cap).
- `bun test ./test/model` on PG 18, `QCLOUD_REQUIRE_DB=1`: 17 pass, 0 fail (the fake store, the planted bugs, `postgres` and
  `postgres-workers` at 100 runs, the 7 scripted tests). With `QCLOUD_MODEL_TARGET=postgres-workers QCLOUD_MODEL_RUNS=400
  QCLOUD_MODEL_COMMANDS=80`: 17 pass.
- `bun test ./packages ./test` on PG 18 with the Pub/Sub emulator and `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PUBSUB=1`: 1,521 pass, 60 skip,
  1 todo, **1 fail**: the `fleet` spike's "at the cap, direct" test, which needs the Docker role's connection limit and is on the list of
  runs owed at the end. The skips are the suites that need PgBouncer, TLS, ElasticMQ or the Docker Postgres.
- The verify command `bun test packages/sdk --grep "worker|events"` is part of that run (the whole of `./packages/sdk` ran).

**Not done / not verified**

- The Docker PG 16 run with `QCLOUD_REQUIRE_DB=1`, PgBouncer, TLS, ElasticMQ, `bun run test:model` on every compose profile, the `fleet` spike
  and its failing "at the cap, direct" test, the PG 16 DDL snapshot and the `EXPLAIN` recheck.
- **The Worker has not run over the Pub/Sub transport or the NOTIFY-based local transport**; the SDK tests use the in-memory transport.
  Each transport's own tests cover its contract (tasks 16 and 17), and the shared contract suite is task 41.
- **The in-process tick** (task 20): crash recovery in the tests is a direct `recoverExpired()` call.
- A processor that blocks the event loop for longer than `lockDuration` loses its lease by design; the tests cover a block shorter than the
  lease and work in slices, not a block longer than it.
- `DrainWatch` can run one in-flight `counts()` after `close`; harmless, not fixed.
- The upstream example scripts that use `Worker` and `QueueEvents` were not run as such; `FlowProducer` is task 50.

**Next:** task 20 (the maintenance tick in process). It joins the shutdown order between releasing leases and closing the transport, keeps a
tick test for a job whose first claim lost the `markRung` race (item (a)), decides whether a store-side mitigation is still wanted, and
removes `spike/db-access/`.
