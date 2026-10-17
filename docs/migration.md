# Moving from Qelay

How to move an application that uses [Qelay](https://github.com/ChxisB/qelay)'s `Queue`, `Worker`, `QueueEvents` and
`FlowProducer` to `qelay-cloud`. The code change is small; the work is in deciding what to do about the differences, which
this page lists in the order you will meet them. [compat.md](compat.md) is the reference: every method, option and event,
with its status. [unsupported.md](unsupported.md) is the short list of what is not here.

Qelay-Cloud covers the BullMQ-style core of Qelay. If you use repeat jobs, job groups' admin methods, manual retry of
failed jobs, batch processing or the embedded mode, read [What will not move](#what-will-not-move) before anything else.

## 1. Understand what changes underneath

| In Qelay | In Qelay-Cloud |
| --- | --- |
| A server process (TCP, or embedded SQLite) holds the jobs | Postgres holds the jobs; a cloud queue rings a doorbell ([concepts](concepts.md)) |
| `connection: { host, port }` | `databaseUrl` (or `database`) and a `transport` |
| Calls are synchronous in embedded mode | Every call is a round trip to Postgres and returns a promise |
| A worker polls | A worker waits for a bell; the tick rings delayed and retried jobs ([delay precision](limits.md#1-delay-precision-by-hosting-mode)) |
| One namespace per server | `namespace`, the tenant of every row; tables are `qcloud_*` |

## 2. Set up the infrastructure

Pick a path: [local](quickstart-local.md) (Postgres is the doorbell, for development and tests), [GCP](quickstart-gcp.md) or
[AWS](quickstart-aws.md). Whatever you pick, run the schema migration before the first producer or worker: a `Queue` never
creates or changes tables, and `waitUntilReady()` rejects with the cause on a database that was not migrated. The migration
is `qcloud-api migrate` in a deployment and `migrate(db)` of `@qelay-cloud/store-postgres` in a script.

## 3. Switch the producers

```ts
// before
import { Queue } from 'qelay';
const queue = new Queue('telemetry', { connection: { host, port } });

// after
import { Queue } from 'qelay-cloud';
const queue = new Queue('telemetry', { databaseUrl, transport, namespace: 'prod' });
```

- Build the `transport` once ([`runtime.ts`](../examples/orders/src/runtime.ts) does it for all three) and share it between
  queues. A `Queue` never closes a transport it was given.
- Add `await` to the calls that did not need it: `getJobs`, `getJobCounts`, `pause`, `isPaused` and the rest are promises now.
- `add` stores the job, then rings the bell after the commit. A ring that fails never fails the `add`: the job stays unrung
  and the tick rings it. You never lose a job to a broker outage.
- Options that Qelay accepted and this does not throw `UnsupportedOptionError` naming the option, at call time, so a test
  run finds them. `durable: true`, which upstream examples pass, is one on `Queue.add`: drop it. (The Control API's add
  route accepts and ignores it.)
- A `FlowProducer` changes the same way, with two limits to check first: a flow is at most 1,000 jobs and 100 levels
  (Qelay allows 10,000 jobs), and it is written in one transaction. See [`FlowProducer`](compat.md#flowproducer).

## 4. Switch the workers

```ts
// before
const worker = new Worker('telemetry', async (job, { signal }) => handle(job.data, signal), {
  connection: { host, port },
  concurrency: 8,
});

// after
const worker = new Worker('telemetry', async (job, { signal }) => handle(job.data, signal), {
  databaseUrl, transport, namespace: 'prod', concurrency: 8,
});
process.on('SIGTERM', () => void worker.close());
```

Check these, in this order:

1. **The options you pass** against the [Worker options](compat.md#options) table. `limiter`, `batch`, `useLocks`,
   `skipStalledCheck`, `maxStalledCount`, `removeOnComplete` and `removeOnFail` on the worker throw, and the message names
   the replacement where there is one: `queue.setGlobalRateLimit` for `limiter`, `queue.setStallConfig({ maxStalls })`
   for the stall options, and the job options of the same names for `removeOn*`.
2. **What the processor reads from `job`.** It receives the claimed job (`id`, `name`, `data`, `attemptsMade`,
   `updateProgress`, `log`, `discard`), not a full `Job`. Anything else (`getState`, `updateData`, `moveTo*`, `parent`) is
   not on it: read the job through a `Queue` when you need more.
3. **Idempotence.** Delivery is at least once. A lease that expires while a job runs hands it to another worker, so a
   processor that must not repeat a side effect keys it on `job.id`.
4. **Blocking the event loop.** The lease is renewed on a timer. A processor that blocks for longer than `lockDuration`
   (30 s by default) cannot renew it and the job is treated as lost. Work in slices or lengthen `lockDuration`.
5. **Waiting.** A job that cannot be claimed when its bell arrives (its group is at its cap, the queue is rate-limited or
   paused) is not polled for. It runs at the next bell or when the tick re-rings it, as does a retry waiting out its
   backoff. Plan for the tick interval as the delay, and run the in-process tick if a minute is too long.
6. **Shutdown.** `close()` always returns. It stops taking bells, gives running jobs `graceMs`, aborts and releases the rest.

## 5. Switch the event listeners

`QueueEvents` reads the event journal in Postgres by polling it, so it needs no direct connection and works through a
pooler. Events arrive once each in commit order, and `queueEvents.cursor` resumes a reader without a gap or a repeat.
Several events carry less than upstream's:

- `completed` has no `returnvalue`: read the job (`queue.getJob(id)`) for its result.
- `failed` has `{ jobId, failedReason, terminal }`, and `terminal: false` is a failed attempt that will be retried. There is
  no `retried` event.
- `delayed` has no `delay`. `drained` is the `Worker`'s event. Pausing and resuming are not journaled.

## 6. Switch the panel

The panel is a clone of the Qelay control panel that talks to the Control API instead of a Qelay server and a control
agent. Point your team at the new panel ([deployment](operations.md)). Its pages follow the old ones. Actions that are not
supported answer `501 not_supported`, and the dead-letter page can purge but not retry.

## 7. Move the jobs

**There is no tool that moves jobs from a Qelay server into Postgres.** Pick one:

- **Drain, then switch.** Stop the producers, let the Qelay workers finish, point everything at Qelay-Cloud.
- **Run side by side.** New work goes to Qelay-Cloud, the old queues drain on Qelay, then you retire it.
- **Re-add.** A script reads waiting jobs from Qelay and calls `queue.addBulk` here. Keep `jobId` if you rely on it. Delayed
  jobs keep their time, never more than 365 days out.

## What will not move

| If you use | Do this instead |
| --- | --- |
| `repeat`, `upsertJobScheduler` | Cron entries exist in the store (`store.crons`, run by the tick), but have no producer API in v1.0.0. A job added by your own scheduler works today. |
| `retryJob`, `retryDlq`, `retryCompleted` | Add a new job. Manual retry needs a version precondition and is a v1.1 candidate. |
| Job groups' admin methods (`pauseGroup`, `setGroupConcurrency`, ...) | The `group` job option and the worker's `group` option work; the admin methods do not. |
| `Forwarder`, `batch`, `embedded` mode, `autoBatch` | Not part of the core. |
| `moveJobTo*`, `extendJobLock` on a `Queue` | A worker does these with its lease; a producer holds no token. |
| `FlowProducer.addChain`, `addBulkThen`, `addTree` | `add` with `children`; read results with `job.getChildrenValues()`. |

Everything in the [full list](unsupported.md) names its replacement. When this page and `compat.md` disagree, `compat.md`
is right: a test fails when a method of Qelay's classes is missing from it.

## Check your work

- Run your test suite against the local transport ([quickstart](quickstart-local.md)). An unsupported option fails there, by
  name.
- Read the `Differs` rows of the tables for every method you call.
- Run the replay of upstream's examples: `packages/sdk/test/queue.replay.test.ts` replays the producer halves of
  `examples/mqtt-bridge` and `examples/postgres-multibroker` of Qelay.
