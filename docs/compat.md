# Qelay `Queue`, `Worker` and `QueueEvents` compatibility

What `Queue`, `Worker` and `QueueEvents` of `qelay-cloud` have, have differently, or do not have, against Qelay's
(upstream commit `c43442c9`: the class chain in `src/client/queue/runtime/*.ts`, `src/client/worker/runtime/*.ts` and
`src/client/events.ts`). Every public method of those classes is in a table below, none left out, and
`packages/sdk/test/queue.compat.test.ts` keeps it so: it fails when a method of one of Qelay's three classes, or of the
one here, is missing from this file.

- **Supported**: same name, same arguments, same result.
- **Differs**: same name, and the difference is stated. Read it before you rely on it.
- **Not supported**: the method does not exist on this `Queue`. The reason is given, and where a call must
  fail loudly, it throws `UnsupportedOptionError`. Nothing is ignored silently.

The scope is decision D6 (the BullMQ-style core). The `Queue` comes first, then [`Worker`](#worker), [`QueueEvents`](#queueevents), [`FlowProducer`](#flowproducer) and the [workflow `Engine`](#workflow-engine); [Switching a producer](#switching-a-producer) and [Switching a consumer](#switching-a-consumer) are the short guides.

## Read these first

1. **Every method is async.** Upstream's embedded mode has synchronous variants (`getJobs`, `getJobCounts`, `pause`,
   `isPaused`, ...) that return a value; every call here is a round trip to Postgres, so each returns a promise. Where
   upstream's TCP client names the async variant `fooAsync`, the same `fooAsync` exists here and calls `foo`.
2. **A `Queue` sees only its own queue.** Job ids are unique per namespace, not per queue. An id that belongs to
   another queue reads as missing (`getJob` is `null`, `getJobState` is `'unknown'`, `remove`/`promote`/`changeDelay`
   do nothing, `updateJobData` and `addJobLog` throw `JobStateError`/`JobNotFoundError`). Adding a custom `jobId`
   that a live job of **another queue** holds throws `UnsupportedOptionError('jobId', ...)`, after the other jobs of
   the call were added.
3. **`add` rings the doorbell after the commit, and a ring failure never fails the `add`.** The job is stored first;
   if the transport is down, the job stays unrung (`rung_at` null) and the tick rings it later. See
   `Queue.add` below and [docs/spikes/06-phase0-gate.md](spikes/06-phase0-gate.md) (invariant 3).
4. **The schema is migrated separately.** A `Queue` never creates or changes tables. Run `migrate(db)` of
   `@qelay-cloud/store-postgres` first; `waitUntilReady()` rejects with the cause on a database that was not migrated.
5. **Unsupported means an error, not a no-op.** An option outside the supported subset throws
   `UnsupportedOptionError` at call time, naming the option.

## Constructor and connection options

`new Queue(name, options)`. `name` is a non-empty string without a NUL character. The constructor opens nothing: the
pool is made by the first call.

| Option | Status | Notes |
| ------ | ------ | ----- |
| `databaseUrl` | New | A Postgres connection string, from the environment or the cloud secret manager, never from the repo. |
| `database` | New | `ConnectionOptions` of the store package (pooler mode, the direct `listenUrl`, TLS, pool size). Passed through unread. One of `databaseUrl`, `database` or `store` is required. |
| `transport` | New, required | The `DeliveryTransport` that rings the doorbell (`@qelay-cloud/transport-local`, `@qelay-cloud/transport-gcp`). The queue never closes it. |
| `namespace` | New | Default `'default'`. Isolates the jobs of one deployment inside one database. |
| `store` | New | A `PostgresStore` the caller owns, for sharing one pool. `close()` leaves it open. Do not pass `databaseUrl`, `database` or `namespace` with it. |
| `logger`, `metrics` | New | Sinks (`warn`, `count`). Errors thrown by a sink are swallowed. |
| `defaultJobOptions` | Supported | Merged under the options of every `add`. Validated when the queue is built. |
| `connection` | Not supported | Upstream selects a TCP or shared connection with it. Use `databaseUrl` or `database`. |
| `host`, `port` | Not supported | The Qelay TCP server does not exist here. |
| `embedded`, `dataPath` | Not supported | Embedded mode is a SQLite-in-process engine. There is none. |
| `autoBatch` | Not supported | No client-side batching: `addBulk` is one transaction. |
| `prefixKey` | Not supported | Namespacing is `namespace`; the tables are `qcloud_*`. |

Each refused option throws `UnsupportedOptionError(key, 'is a Qelay option and is not supported: <advice> (docs/compat.md)')`.

## `Queue` methods

### Adding jobs

| Method | Status | Notes |
| ------ | ------ | ----- |
| `add(name, data, opts?)` | Differs | Async. Resolves once the job is stored; ringing happens after the commit and a failure of it is logged (`'ring failed'`, `'bell not rung'`), counted (`qcloud.ring.failed`, `qcloud.ring.deferred`) and swallowed. A custom `jobId` or deduplication key that matches a live job resolves with that job and `duplicated: true`. A delay beyond the transport's `maxDeliverDelayMs` is not an error: the job waits unrung for the tick. Options outside the supported subset throw `UnsupportedOptionError` before anything is written (see [Job options](#job-options)). |
| `addBulk(jobs)` | Differs | In one transaction, in order. Every job's options are validated before anything is sent. Bells are rung in chunks of the transport's `maxRingBatch`; a half-failed batch leaves exactly the failed bells unrung. Each item is `{ name, data, opts? }`. |

### Reading one job

| Method | Status | Notes |
| ------ | ------ | ----- |
| `getJob(id)` | Differs | `null` when this queue has no such job. The `Job` is a snapshot; see [Job](#job). |
| `getJobState(id)` | Supported | `'unknown'` for a missing job or one of another queue. |
| `getJobLogs(id, start?, end?)` | Differs | `{ logs, count }`; each line is `[level] message`. |
| `addJobLog(id, row, keepLogs?, level?)` | Supported | Returns the number of lines the job holds. `JobNotFoundError` for a missing job. |
| `clearJobLogs(id, keepLogs?)` | Supported | |
| `updateJobProgress(id, progress)` | Differs | Takes effect on an **active** job only; on any other it resolves and changes nothing. A number is kept clamped to 0..100, an object becomes 0 with its JSON as the message, a numeric string or boolean is `Number(value)`. It does not change the job's `version`. Journals a `progress` event. |
| `updateJobData(id, data)` | Supported | `JobStateError` for a finished or missing job, as upstream. An active job may be updated; its worker keeps the data it was handed. |
| `changeJobDelay(id, delay)` | Differs | Only a **delayed** job changes; any other state resolves and changes nothing. A delay of 0 makes it claimable now (and rings it). A delay over 365 days, or not finite, throws `UnsupportedOptionError`. A negative delay is read as 0. |
| `changeJobPriority(id, { priority, lifo? })` | Differs | `lifo` throws `UnsupportedOptionError`: the stack order is fixed when the job is added. |
| `promoteJob(id)` | Supported | A delayed job becomes due now and is rung. Any other state: no change. |
| `remove(id)` / `removeAsync(id)` | Supported | `JobStateError` for an active job; `FlowProtectedError` for a job a live flow parent waits on. A missing job resolves. |
| `getChildrenValues(id)` | Not supported | Read it through the job: `(await queue.getJob(id))?.getChildrenValues()`. See [`FlowProducer`](#flowproducer). |
| `extendJobLock(id, token, duration)` | Not supported | A job's lease belongs to the `Worker` that holds it, which renews it by itself; a producer has no token. |
| `retryJob(id)`, `retryJobs(opts?)` | Not supported | A failed job is retried by the store's retry rules (`attempts`, `backoff`) or lands in the DLQ. Manual retry of a failed job needs the version precondition of task 14 (k) and is a v1.1 candidate. |

### Listing and counting

| Method | Status | Notes |
| ------ | ------ | ----- |
| `getJobs(opts?)` / `getJobsAsync` | Differs | `opts` is `{ state?, start?, end?, asc? }`. `state` is a state name or an array of them. `end` is exclusive and defaults to **100**. `end: -1` (everything), `asc`, an unknown state and a window of more than **1,000** throw `UnsupportedOptionError`, so no call reads a whole queue. `'paused'` is not a state you can list: a paused queue's ready jobs are listed under their own states. |
| `getWaiting`, `getPrioritized`, `getDelayed`, `getActive`, `getCompleted`, `getFailed`, `getWaitingChildren` (`(start?, end?)`) | Differs | `getJobs` of one state, with the same bounds. `getWaitingAsync`, `getDelayedAsync`, `getActiveAsync`, `getCompletedAsync` and `getFailedAsync` are twins; `getPrioritized` and `getWaitingChildren` have no twin upstream either. |
| `getJobCounts()` / `getJobCountsAsync` | Differs | Takes no arguments and returns every state: `waiting`, `prioritized`, `active`, `completed`, `failed`, `delayed`, `paused`, `waiting-children`. While the queue is paused, its ready jobs are counted under `paused`. |
| `getWaitingCount`, `getPrioritizedCount`, `getActiveCount`, `getCompletedCount`, `getFailedCount`, `getDelayedCount`, `getWaitingChildrenCount` | Differs | Async. Each is one field of `getJobCounts()` (so they follow its paused view). |
| `count()` / `countAsync` | Differs | Jobs still to run: waiting, prioritized, delayed, and those a pause holds. |
| `getCountsPerPriority`, `getCountsPerPriorityAsync` | Not supported | There is no read model of counts per priority; it would be a scan. |
| `getCountsPerPriorityForGroup` | Not supported | Group methods: see [Groups](#groups). |
| `getWorkers()`, `getWorkersCount()` | Differs | Async. The workers registered in this namespace that take jobs of this queue (`WorkerInfo[]`). |

### Control

| Method | Status | Notes |
| ------ | ------ | ----- |
| `waitUntilReady()` | Differs | Resolves when the database answers **and holds a migrated schema**. |
| `pause()` / `pauseAsync`, `resume()` / `resumeAsync`, `isPaused()` / `isPausedAsync` | Differs | Async. `resume` rings nothing: the tick re-rings what was held, within its interval. |
| `drain()` / `drainAsync` | Differs | Deletes the waiting, prioritized and delayed jobs in bounded batches and resolves with how many. Upstream also drains `waiting-children` jobs; those are flow parents here and go through `remove`. A job a claim holds, or one a live flow parent waits on, is skipped. |
| `obliterate({ force? })` / `obliterateAsync` | Differs | Deletes the queue and everything of it, in batches. `JobStateError` for an active job unless `force`. Refuses what a live flow parent waits on. |
| `clean(grace, limit, type?)` / `cleanAsync` | Differs | Returns the removed ids. `type`: `completed` (default), `failed`, `wait`/`waiting`, `prioritized` or `delayed`. `active`, `paused` and any other type throw `UnsupportedOptionError`. `limit` 0 means all, done in batches of at most 10,000. A negative or non-finite `grace` or `limit` throws `UnsupportedOptionError`. |
| `promoteJobs({ count? })` | Differs | Makes up to `count` (1 to 1,000, default 1,000) delayed jobs due now and resolves with how many. |

`drain`, `clean` and `obliterate` are the panel's destructive actions. The store gives them bounded, journaled,
flow-guarded implementations, and the Control API (task 31) takes them with `{ confirm: <queue name> }`. The **panel's**
buttons send no confirmation yet and get 400 `confirmation_required` until task 34 adapts them.

### Configuration and the DLQ

| Method | Status | Notes |
| ------ | ------ | ----- |
| `setStallConfig(config)` / `getStallConfig()` (+ `Async`) | Differs | Only `maxStalls` is supported. Any other key throws `UnsupportedOptionError`. The default is 3. |
| `setDlqConfig(config)` / `getDlqConfig()` (+ `Async`) | Differs | Only `maxEntries` and `maxAge`. `autoRetry`, `autoRetryInterval` and `maxAutoRetries` throw `UnsupportedOptionError`: DLQ retry is closed (see below). |
| `getDlq(filter?)` / `getDlqAsync` | Differs | `filter` is `{ limit?, offset? }` only; one page, oldest failure first. Upstream's `reason`, `olderThan`, `newerThan`, `retriable` and `expired` filters throw `UnsupportedOptionError`. |
| `getDlqJobsAsync(count?)` | Differs | The failed jobs behind the first `count` entries. |
| `getDlqStats()` / `getDlqStatsAsync` | Supported | |
| `purgeDlq()` / `purgeDlqAsync` | Supported | Deletes every entry and its failed job; resolves with how many. |
| `removeDlqJob(id)` / `removeDlqJobAsync` | Supported | Resolves `true` when an entry was removed. |
| `retryDlq`, `retryDlqAsync`, `retryDlqByFilter`, `retryDlqByFilterAsync` | Not supported | **DLQ retry is closed, fail-closed**, as the Phase 0 gate decided (task 14 (k)): reopening it needs the `version` precondition and an entry fence, a v1.1 candidate. |
| `retryCompleted`, `retryCompletedAsync` | Not supported | Same reason: re-running a finished job needs the same precondition. Add a new job instead. |

**The Control API serves these too** (task 32), from the same store calls: `GET /queues/:q/dlq` (with `limit` and
`offset`), `/dlq/stats`, `DELETE /queues/:q/dlq/:id`, `POST /queues/:q/dlq/purge` (`{ confirm: <queue name> }`, like
drain), and `GET`/`PUT` on `/queues/:q/stall-config` and `/dlq-config`. What `Queue` refuses it refuses as well: a
retry, a DLQ auto-retry and a change of DLQ retention answer 501 `not_supported` naming the action (`dlq-retry`,
`dlq-auto-retry`, `dlq-retention`, all listed under `unsupported` in `GET /capabilities`), and a stall setting other
than `maxStalls` is 400 `unsupported_option` unless it is sent back as read. Crons
(`/crons`), workers (`/workers`), the event stream (`GET /events`), metrics and the operator audit log (`GET /audit`)
are described in `packages/control-api/README.md`.

### Global concurrency and rate limit

| Method | Status | Notes |
| ------ | ------ | ----- |
| `setGlobalConcurrency(n)` / `removeGlobalConcurrency()` / `getGlobalConcurrency()` (+ `Async` for the first two) | Differs | At most `n` jobs of the queue active at once **across every worker**. `getGlobalConcurrency` resolves with `null` when none is set. |
| `setGlobalRateLimit(max, duration?)` / `removeGlobalRateLimit()` / `getGlobalRateLimit()` (+ `Async` for the first two) | Differs | At most `max` claims in each window of `duration` ms (default 1,000). `getGlobalRateLimit` resolves with `{ max, duration }` or `null`. |
| `rateLimit(expireTimeMs)`, `getRateLimitTtl()`, `isMaxed()` | Not supported | These belong to a running worker (a handler asking the queue to back off), and the store has no time-boxed rate limit to ask. Use `setGlobalRateLimit`. |

### Groups

| Method | Status | Notes |
| ------ | ------ | ----- |
| `getGroupJobsCount`, `getGroupsJobsCount`, `getGroupActiveCount`, `getGroupJobs`, `getCountsPerPriorityForGroup` | Not supported | The `group` **job option** is supported (`{ id, maxSize?, priority? }`), and claims honor the group state the store keeps. There is no store facet that reads or writes group state for a producer yet; a v1.1 candidate. |
| `setGroupRateLimit`, `getGroupRateLimit`, `removeGroupRateLimit`, `getGroupRateLimitTtl` | Not supported | Same. |
| `setGroupConcurrency`, `getGroupConcurrency`, `removeGroupConcurrency` | Not supported | Same. |
| `pauseGroup`, `resumeGroup`, `isGroupPaused` | Not supported | Same. |

### Job schedulers

| Method | Status | Notes |
| ------ | ------ | ----- |
| `upsertJobScheduler`, `removeJobScheduler`, `getJobScheduler`, `getJobSchedulers`, `getJobSchedulersCount` | Not supported | Qelay's job schedulers are repeat jobs (`repeat` option), which D6 leaves out of v1.0.0. Cron schedules exist in the store (`store.crons`, used by the tick) but have no producer API here. A v1.1 candidate. |

### Deduplication

| Method | Status | Notes |
| ------ | ------ | ----- |
| `getDeduplicationJobId(key)` | Not supported | The `deduplication` **job option** is supported (`{ id, ttl? }`, with the `duplicated` marker on the result). The store has no facet that looks a key up or releases it; a v1.1 candidate. |
| `removeDeduplicationKey(key)` | Not supported | Same. |

### Moving jobs and flows

| Method | Status | Notes |
| ------ | ------ | ----- |
| `moveJobToCompleted`, `moveJobToFailed`, `moveJobToWait`, `moveJobToDelayed` | Not supported | These move an **active** job for the worker that holds its lease. The `Worker` (task 19) does it with a lease token; a `Queue` never holds one. |
| `moveJobToWaitingChildren`, `waitJobUntilFinished` | Not supported | `moveJobToWaitingChildren` moves an active job for the worker that holds its lease, and a flow parent is written `waiting-children` by `FlowProducer.add` instead. To wait for a job, listen to a [`QueueEvents`](#queueevents) for its `completed` or `failed`, or poll `getJobState`. |
| `getJobDependencies`, `getJobDependenciesCount`, `getDependencies` | Not supported | Read them through the job: `job.getDependencies()` returns `{ processed, unprocessed }`; there is no count and no paging, because a flow has at most 1,000 jobs. See [`FlowProducer`](#flowproducer). |

### Lifecycle and other

| Method | Status | Notes |
| ------ | ------ | ----- |
| `close(options?)` | Differs | Closes the pool when this queue opened it; a `store` passed in stays open, and the transport is never closed. Idempotent. `options.timeout` bounds the wait. |
| `disconnect()` | Supported | The same as `close()`. |
| `forward(options)` | Not supported | `Forwarder` is outside v1.0.0 (D6). |
| `trimEvents(...)` | Not supported | The journal is trimmed by the tick's retention rules, not by a producer. |
| `getMetrics(type, start, end)` | Not supported | The panel reads throughput through the store's read models. A v1.1 candidate for the SDK. |
| `constructor` | Differs | See [Constructor and connection options](#constructor-and-connection-options). |

## Names the task plan uses

The plan for this package names some methods differently from Qelay. Each of these exists and calls the Qelay-named
method, so either spelling works:

| Plan name | Qelay name |
| --------- | ---------- |
| `removeJob(id)` | `remove(id)` |
| `promote(id)` | `promoteJob(id)` |
| `updateData(id, data)` | `updateJobData(id, data)` |
| `changePriority(id, opts)` | `changeJobPriority(id, opts)` |
| `changeDelay(id, delay)` | `changeJobDelay(id, delay)` |
| `setConcurrency(n)`, `clearConcurrency()` | `setGlobalConcurrency(n)`, `removeGlobalConcurrency()` |
| `setRateLimit(max, duration?)`, `clearRateLimit()` | `setGlobalRateLimit(max, duration?)`, `removeGlobalRateLimit()` |
| `getJobByCustomId(id)` | `getJob(id)` (ids **are** the custom ids) |

## Job

`add`, `getJob` and the list methods return a `Job`. It is a **snapshot** taken when the job was read: `getState()` and
the `is*` methods read again.

| Field or method | Status | Notes |
| --------------- | ------ | ----- |
| `id`, `name`, `queueName`, `data`, `opts`, `priority`, `progress`, `returnvalue`, `failedReason`, `processedOn`, `finishedOn` | Supported | `opts` shows the options as stored. `delay` is spent when the job is added and is not shown. |
| `timestamp` | Differs | Epoch ms of creation: the **client clock** for a job that `add` returned, the **database clock** for one that was read. The `timestamp` job option is not supported. |
| `attemptsMade` | Differs | The store's attempt counter, which moves only when an attempt **fails or stalls**. It is 0 while a job is active and after a clean first-try completion. Upstream maps it the same way. |
| `duplicated` | New | `true` when `add` returned a live job that matched the custom id or deduplication key. |
| `updateProgress(progress, message?)`, `log(message, level?)`, `getState()` | Supported | As the queue methods of the same meaning. |
| `isWaiting()`, `isActive()`, `isDelayed()`, `isCompleted()`, `isFailed()`, `isWaitingChildren()` | Differs | Async. |
| `updateData(data)`, `remove()`, `promote()`, `changeDelay(delay)`, `changePriority(opts)` | Supported | As the queue methods of the same meaning; `updateData` also replaces `job.data`. |
| `getChildrenValues()`, `getDependencies()`, `getFailedChildrenValues()`, `getIgnoredChildrenFailures()` | Supported | Of a flow parent; see [`FlowProducer`](#flowproducer). Each is one bounded database read. On a job without children they resolve empty. `getDependencies()` differs in one case, stated there. |
| `retry`, `extendLock`, `token`, `parent`, `stacktrace`, `repeatJobKey`, `moveTo*` | Not supported | Not part of the v1.0.0 subset; see the queue methods above. |

## Job options

| Option | Status |
| ------ | ------ |
| `priority`, `lifo`, `delay`, `attempts`, `backoff`, `timeout`, `stallTimeout`, `jobId`, `deduplication`, `group` | Supported, with the bounds `validateJobOptions` of `@qelay-cloud/core` states (`priority` an integer from 0, `delay` at most 365 days, `backoff` a number or `{ type: 'fixed' \| 'exponential', delay, maxDelay? }`, and so on) |
| `removeOnComplete`, `removeOnFail` | Supported as booleans only. Age and count retention is unsupported upstream too. |
| `repeat`, `debounce` | Not supported (D6) |
| `durable` | Not supported. Qelay's durable-write flag has no meaning when Postgres is the store; the upstream multibroker example passes `{ durable: true }`, so drop it. |
| `parent`, `failParentOnFailure`, `removeDependencyOnFailure`, `continueParentOnFailure`, `ignoreDependencyOnFailure` | Not supported on `Queue.add`: `UnsupportedOptionError`, "belongs to a flow". They are the options of a [`FlowProducer`](#flowproducer) flow, which sets the parent itself; the four flags are supported there on a child. |
| `keepLogs`, `stackTraceLimit`, `sizeLimit`, `timestamp` | Not supported |
| Any other key | Not supported: `UnsupportedOptionError`, `'is unknown'` |

**The Control API's `POST /queues/:q/jobs` takes the same options** and refuses the unsupported ones as 400
`unsupported_option` with `details.option` (and `details.index` in a bulk add), where this `Queue` throws
`UnsupportedOptionError`. Two differences from the table: `durable: true` is accepted and ignored there (a form that
sends it keeps working; `durable: false` is refused), and a job of a bulk add may name its custom id `customId`, as
Qelay's bulk body does (`jobId` works too, and the two must agree).

## `Worker`

`new Worker(name, processor, options)` takes the jobs of one queue. It is woken by doorbells, not by polling: the
transport delivers a bell, the worker claims up to its free slots from Postgres, runs the processor, and completes or
fails the job. `docs/spikes/06-phase0-gate.md` ("The Worker and QueueEvents (task 19)") has the rules it keeps.

### Read these first

1. **A bell is a nudge, not a job.** The worker claims from the queue, never by the bell's job id, and acknowledges the
   bell after the claim attempt, not after the job. An empty claim is normal. One exception costs nothing when it does
   not apply: a claim never waits for a row another transaction holds, and right after a ring that is the record of the
   bell itself, so an empty claim while the queue still has a job waiting is made once more after 25 ms (never a third
   time, whatever blocks the job). It is the queue that counts, not the bell's own job, because another claim may have
   taken that one while a different job is the locked one.
2. **A worker keeps its own slots.** At most `concurrency` jobs run, however many bells the transport delivers, and a
   busy worker asks the transport for none. When a job ends, the worker asks for more.
3. **Some jobs wait for the next bell or the tick, not for the worker.** A job that cannot be claimed when its bell
   arrives (its group is at its cap, the queue is rate-limited or paused) is not polled for: it runs at the next bell,
   or when the tick re-rings it. The same holds for a retry that waits out its backoff, and for a job whose worker died.
   Qelay's worker polls and so resumes by itself; plan for the tick interval (task 20) as the delay.
4. **A processor must not block the event loop for longer than `lockDuration`.** The lease is renewed on a timer. A
   loop blocked past the lease length cannot renew it, and the worker then treats the job as lost: `stalled` is
   emitted, the signal aborts, and nothing is written for the job. Work in slices, or give the job more `lockDuration`.
5. **A lost lease means no write.** A worker whose lease is lost, or could not be confirmed in time, never completes,
   fails or releases that job. The processor keeps its slot until it returns, and its result is dropped.
6. **`close()` always returns.** It stops taking bells, lets running jobs finish for `graceMs`, aborts the rest and
   releases their leases without counting a failure, and is bounded by `graceMs + 2 × timeout` whatever the database or
   the broker does.
7. **At-least-once.** A worker killed mid-job leaves the lease to expire; recovery counts one attempt for the crash and
   the job runs again. A processor that must not repeat its side effects keys them on `job.id`.

### Processor

`(job, { signal }) => result | Promise<result>`, as in Qelay. `signal` aborts when the lease is lost or cannot be
confirmed and when `close` runs out of grace. The job is a `WorkerJob`:

| Member | Status | Notes |
| ------ | ------ | ----- |
| `id`, `name`, `queueName`, `data` | Supported | |
| `attemptsMade` | Differs | Attempts that **failed or stalled** before this one: 0 on the first try, whatever the worker did. |
| `updateProgress(progress, message?)`, `log(message, level?)` | Differs | Best effort: a store failure is logged and counted, never thrown into the processor, and nothing is written once the lease is lost or the worker is closing. |
| `discard()`, `isDiscarded()` | Supported | The job fails for good if this attempt fails. Throwing `UnrecoverableError` does the same. |
| `opts`, `progress`, `getState()`, `isFailed()` and the other `is*` methods, `updateData`, `retry`, `promote`, `remove`, `moveTo*`, `extendLock`, `token`, `parent`, `getChildrenValues` | Not supported | A processor receives the claimed job, not a `Job` read from the store. Read it through a `Queue` when you need more. |
| An `ObservableLike` return value | Not supported | Return a value or a promise. |

### Options

The connection options are a `Queue`'s, minus `defaultJobOptions`.

| Option | Status | Notes |
| ------ | ------ | ----- |
| `concurrency` | Supported | An integer from 1 to 10,000, default 1. Read-only afterwards: there is no setter. |
| `autorun` | Supported | Default true; with false, call `run()`. |
| `lockDuration` | Differs | The lease length in ms, default 30,000, at least 50. It sets the store's `leaseMs`, which sets how far each renewal extends the lease; a `store` passed in must already have the same value, or the constructor throws. The worker renews at a third of it. |
| `heartbeatInterval` | Differs | The interval of the worker's row in `qcloud_workers` (default 10,000; 0 registers once and never beats). Job leases are renewed at a third of `lockDuration`, whatever this is. |
| `group` | Supported | `{ concurrency?, limit?: { max, duration } }`, applied by the claim; `limit` is a fixed window. |
| `workerName` | New | The display name in the worker list. Default: the worker's id. |
| `drainedAfterMs` | New | How long the worker is idle before it checks the queue and emits `drained`. Default 250. |
| `closeTransport` | New | Close the transport together with the worker. Default false: the transport belongs to the caller. |
| `databaseUrl`, `database`, `transport`, `namespace`, `store`, `logger`, `metrics` | New | As on the `Queue`. |
| `connection`, `host`, `port`, `embedded`, `dataPath`, `prefixKey` | Not supported | As on the `Queue`. |
| `batchSize`, `pollTimeout`, `drainDelay` | Not supported | The worker waits for bells and does not poll. A bell claims as many jobs as the free slots allow. |
| `useLocks`, `skipLockRenewal` | Not supported | A job is always leased and renewed. |
| `skipStalledCheck`, `maxStalledCount` | Not supported | Recovery is the tick's, not the worker's. The limit is per queue: `queue.setStallConfig({ maxStalls })`. |
| `limiter` | Not supported | A rate limit is the queue's and holds across workers: `queue.setGlobalRateLimit`. |
| `batch` | Not supported | Batch processing is not supported. |
| `removeOnComplete`, `removeOnFail` | Not supported | Give them to the job: `JobOptions.removeOnComplete`, `removeOnFail`. |

### Methods

| Method | Status | Notes |
| ------ | ------ | ----- |
| `constructor` | Differs | Throws `UnsupportedOptionError` for an unsupported option, before anything opens. See Options. |
| `run()` | Supported | Starts taking jobs and registers the worker. Does nothing when already running or closing. |
| `pause()`, `resume()`, `isRunning()`, `isPaused()`, `isClosed()` | Supported | Jobs already running continue while paused. |
| `waitUntilReady()` | Differs | Resolves once the worker is registered, which proves that the database answers and holds a migrated schema; rejects with the cause otherwise. |
| `concurrency` | Differs | A getter. Upstream also has a setter; give the number to the constructor. |
| `close(force?)` | Differs | `close()`, `close(true)` (no grace) or `close({ graceMs?, timeout? })`. Idempotent: later calls return the first call's promise. Closes the store when this worker opened it, the transport only with `closeTransport`. |
| `disconnect()` | New | The same as `close()`. |
| `closing` | Not supported | Keep the promise `close()` returns. |
| `cancelJob(id, reason?)`, `cancelAllJobs(reason?)`, `isJobCancelled(id)` | Not supported | Stop work through the processor's `signal`; it aborts when the lease is lost and when `close` runs out of grace. |
| `rateLimit(ms)`, `isRateLimited()`, `getRateLimiterInfo()`, `rateLimitGroup(job, duration)`, `Worker.RateLimitError()` | Not supported | Rate limits belong to the queue (`setGlobalRateLimit`) and to groups (`group.limit`). |
| `startStalledCheckTimer()` | Not supported | Recovery is the tick's. |
| `delay(ms?, abortController?)` | Not supported | An internal helper upstream. |
| `getNextJob(token?, opts?)`, `processJobManually(...)`, `extendJobLocks(ids, tokens, duration)` | Not supported | Manual processing is outside v1.0.0. |
| `on(event, listener)`, `once`, `off` | Supported | Typed by event. A listener that throws is logged and does not stop the other listeners or the worker. |

### Events

| Event | Status | Notes |
| ----- | ------ | ----- |
| `ready`, `closed` | Supported | |
| `drained` | Supported | The worker is idle and the queue has no waiting or prioritized job, checked `drainedAfterMs` after the worker went idle. Emitted again after new work. |
| `active`, `completed`, `failed`, `log` | Supported | `completed(job, result)` and `failed(job, error)` fire only when this worker's write landed. |
| `progress` | Differs | `(job, progress)` where `progress` is what the processor passed: a number, an object or a string. |
| `stalled` | Differs | `(jobId, reason)` with `reason` `'lease-lost'` or `'lease-unconfirmed'`. The worker emits it for its own jobs only; recovery of a dead worker's job is seen through `QueueEvents`. |
| `error` | Differs | Registry, claim and heartbeat problems, `OutcomeUnknownError` and `LeaseLostError` among them. With no listener, the error is logged through `logger` and not thrown. |
| `cancelled` | Not supported | There is no cancellation. |

## `QueueEvents`

`new QueueEvents(name, options)` streams the job events of one queue from the event journal (`qcloud_events`). It
**polls** the journal over the pool: there is no `LISTEN`/`NOTIFY`, so it needs no direct connection and works through a
transaction pooler. `pollInterval` (default 250 ms) is the delay it adds when the queue is quiet; a busy queue is read
back to back.

Events arrive in commit order, once each, and `queueEvents.cursor` is exact after every event: store it, and a new
reader built with `start: cursor` resumes without a gap or a repeat. If the journal deleted events the reader had not
read (retention, `maxQueueEvents`), the reader emits `gap` and goes on from what is left.

### Options

| Option | Status | Notes |
| ------ | ------ | ----- |
| `start` | New | `'now'` (default), `'beginning'` (everything the journal still holds) or an `EventCursor` from `queueEvents.cursor`. |
| `pollInterval` | New | Milliseconds between reads while quiet, 1 to 3,600,000. Default 250. |
| `batchSize` | New | Events per read, 1 to 5,000. Default 1,000. |
| `autorun` | New | Default true; with false, call `run()`. |
| `databaseUrl`, `database`, `namespace`, `store`, `logger`, `metrics` | New | As on the `Queue`; `store` is left open by `close()`. |
| `connection`, `embedded`, `dataPath`, `prefixKey` | Not supported | As on the `Queue`. |

### Methods

| Method | Status | Notes |
| ------ | ------ | ----- |
| `constructor` | Differs | Throws `UnsupportedOptionError` for an unsupported option. |
| `on(event, listener)`, `once` | Supported | Typed by event. A listener that throws is logged and does not stop the other listeners or the stream. |
| `waitUntilReady()` | Differs | Resolves after the first successful read; rejects with its cause, and the reader keeps trying. |
| `close()`, `disconnect()` | Differs | Async and idempotent; `disconnect` is the same promise. Closes the store only when this reader opened it. |
| `emitError(error)` | Not supported | An internal method upstream. |
| `run()`, `cursor` | New | `run()` starts a reader built with `autorun: false`; `cursor` is where the reader stands. |

### Events

| Event | Status | Notes |
| ----- | ------ | ----- |
| `waiting` | Differs | `{ jobId }`. Also for a job that returns to waiting (retry, promotion, release). |
| `active`, `stalled`, `duplicated`, `waiting-children` | Supported | `{ jobId }`. |
| `completed` | Differs | `{ jobId }` without `returnvalue`. Read the job (`queue.getJob`) for its result. |
| `failed` | Differs | `{ jobId, failedReason, terminal }`. `terminal` is false for a failed attempt that will be retried and true for the last one, a stall that used the last attempt included. No `data`. |
| `progress` | Differs | `{ jobId, data }` where `data` is the progress **value** when it is a number; the text of an object or string progress is in the job row, not in the event. |
| `removed` | Supported | `{ jobId, prev }`. |
| `delayed` | Differs | `{ jobId }` without `delay`. |
| `obliterated` | New | `{ queue }`. |
| `gap` | New | Events were deleted before this reader read them. |
| `error` | Differs | A read of the journal failed; the reader retries with a growing pause. Upstream also emits `error` for a failed job; listen to `failed`. |
| `retried`, `drained`, `paused`, `resumed` | Not supported | A retried attempt is a `failed` with `terminal: false`; `drained` is the `Worker`'s event; pausing and resuming are not journaled. |

## `FlowProducer`

A parent job that waits for its children, which may be parents themselves, in any queues of the namespace. The flow is
rows in `qcloud_jobs`, `qcloud_dependencies` (one per parent-child edge, with the child's failure policy) and
`qcloud_flow_failures`, and it behaves the same on every transport: a parent is never rung while it has an unfinished
child, and it is released in the transaction that finishes its last child. Every public method of Qelay's `FlowProducer`
is in the table.

| Method | Status | Notes |
| ------ | ------ | ----- |
| `constructor(options)` | Differs | Takes what a [`Queue`](#constructor-and-connection-options) takes (`databaseUrl` or `database`, `transport`, `namespace`, ...) and throws `UnsupportedOptionError` for what that does not. It opens nothing: the first call connects. |
| `waitUntilReady()` | Supported | Resolves when the database answers and the schema is migrated; rejects with the cause. |
| `add(flow, opts?)` | Differs | Writes the whole flow in **one transaction**, so all of its jobs exist or none do. Resolves with the `Job`s in the shape of the input. Rings only the children that are claimable (and never the parents) after the commit; a ring failure never fails the call, the tick rings what was missed. `FlowError` for a flow that cannot be written, nothing written. See the rules below. |
| `addBulk(flows, opts?)` | Differs | Each flow in a transaction of its own, in order. **Every flow is checked first**, so a malformed one rejects the call with nothing added; a failure after that (a custom id that is taken, the database going away) leaves the flows before it added. Not atomic across flows. Upstream's `addBulk` takes no `opts`. |
| `getFlow({ id, queueName, depth?, maxChildren? })` | Differs | The flow under a job as it is now, one query per level; `null` when no job has that id in that queue. A child that was removed when it completed (`removeOnComplete`) is not listed, nor is anything hanging under it. |
| `close(options?)`, `disconnect()` | Supported | Close the connections this producer opened (not a `store` passed in, never the transport). Idempotent. |
| `addChain`, `addBulkThen`, `addTree`, `getParentResult`, `getParentResults` | Not supported | Upstream's legacy flow API (`FlowStep`, `FlowResult`). Use `add` with `children`; read results with `job.getChildrenValues()`. |

### What a flow may contain

A node is `{ name, queueName, data?, opts?, children? }`, as in Qelay.

| Rule | Behaviour |
| ---- | --------- |
| Size | At most **1,000 jobs** and **100 levels** deep. Upstream allows 10,000 jobs: a flow is one transaction that takes one advisory lock per job, so it is held to one enqueue batch. `FlowError` beyond either, before anything is written. |
| Options | The supported job options (`priority`, `delay`, `attempts`, `backoff`, `timeout`, `stallTimeout`, `jobId`, `lifo`, `removeOnComplete`, `removeOnFail`) apply to any node. `queuesOptions[queue].defaultJobOptions` and the producer's defaults are merged under a node's own. Anything else throws `UnsupportedOptionError`. |
| `deduplication` | Refused in a flow (`FlowError`): a dedup key is about one job, not a tree. |
| `group` | Refused on a node that has children: a parent is not in a group. Allowed on a leaf. |
| Custom `jobId` | Must not contain `:`, which the keys of `getChildrenValues` use. Used twice in one flow is a `FlowError`. A custom id that a **live** job holds is a `FlowError` for a non-root node. A finished job's id is taken over, as `Queue.add` does. |
| Data | Not restricted to objects: any value a job may carry. Upstream requires an object without `__` keys. |
| A node object used twice, or a cycle | `FlowError`. |

### Failure policies

Set on a **child** through its options, in Qelay's names. A child that sets several follows the precedence below. The
policy decides what the child's **terminal** failure (its last attempt failed, or its lease ran out on its last attempt)
does to its parent. A failed attempt that will be retried does nothing.

| Option on the child | The parent |
| ------------------- | ---------- |
| `failParentOnFailure` | Fails with `Child job <id> failed: <error>`, written to the DLQ with reason `explicit_fail`. If that parent is itself a child, its own policy applies in turn. No `failed` metric is counted for it. |
| `continueParentOnFailure` | Is released at once, whatever its other children are doing. The error is read with `getFailedChildrenValues()`. |
| `ignoreDependencyOnFailure` | No longer waits for this child. The error is read with `getIgnoredChildrenFailures()`. |
| `removeDependencyOnFailure` | No longer waits for this child. Nothing is recorded. |
| none | Keeps waiting. A failed child with no policy **blocks its parent** until an operator retries the child, promotes the parent or cancels it (see [Operators and a flow](#operators-and-a-flow)). |

Precedence when one child sets several, and when several children of one parent end together: `fail` over `continue`
over `ignore` over `remove`. A child with `removeOnFail` must set one of the four: a child that deletes itself would
otherwise leave its parent waiting for ever, and `FlowError` says so.

**A failure after the parent was released** is still recorded (`continue`, `ignore`) and still drops its edge
(`continue`, `ignore`, `remove`), so the parent reads it when it runs; a late `failParentOnFailure` does nothing to a
parent that has been released.

### What the parent reads

| Method of the parent's `Job` | Result |
| ---------------------------- | ------ |
| `getChildrenValues()` | The return value of every completed child, by `"<queue>:<id>"`. |
| `getDependencies()` | `{ processed, unprocessed }`: the results of the completed children and the children it still waits for. A child whose failure was recorded under `continue`, `ignore` or `remove` is in neither. **Differs:** a child that failed with no policy is `unprocessed` here; upstream lists it as processed with a null result. |
| `getFailedChildrenValues()` | The errors recorded under `continue`, by `"<queue>:<id>"`. |
| `getIgnoredChildrenFailures()` | The errors recorded under `ignore`. |

### Operators and a flow

| Action | Result |
| ------ | ------ |
| Cancel a child | Releases its edge. The parent is rung by the next tick, not at once. |
| Cancel or remove a parent | Deletes its edges and recorded failures. Its children keep running as plain jobs; their `parent_id` and `flow_root` stay until a new flow takes the parent's id, and that flow's `add` detaches them (their `parent_id` and `flow_root` are cleared and their `version` moves), so a reused custom id never shows an old child in `getFlow` or in the Control API's view. |
| `remove`, `clean`, `drain`, `obliterate`, DLQ purge or eviction of a child | Refused (`FlowProtectedError`) or skipped while a parent in `waiting`, `prioritized`, `delayed`, `waiting-children` or `active` holds an edge to it. |
| Retry a failed child from the DLQ, or with `Queue.retryJobs` | Not supported for any job (DLQ retry is closed, see [Configuration and the DLQ](#configuration-and-the-dlq)). A child that failed with no policy is retried through the flow instead (next table). |
| `Queue.promoteJobs` on a `waiting-children` parent | Refused: only a `delayed` job that is not yet due can be promoted. A stuck parent is released through the flow (next table). |

The Control API (`POST /flows/:id/actions`, the `operator` role, one audit row per call) is where an operator acts on a
whole flow. Each action names the jobs it touches with the `version` it read (`expectedVersion`) and is one transaction:
it is applied whole or not at all. A job whose version moved is refused with 409 `version_conflict`, and a job the flow has
that the request did not name makes the request `flow_changed`, so nothing is done on the strength of an old picture.

| Flow action | What it does | Refused (409) |
| ----------- | ------------ | ------------- |
| `retry-failed` | Puts each named failed child back on its queue as a fresh job (no attempts used, no error, no DLQ entry); the parent is released when they complete. | `flow_not_retryable`: a job that is not `failed`, whose parent no longer waits for it, whose edge has a policy (`continue`, `ignore`, `remove`: it holds nothing back), or that is a parent that never ran (one that failed because a child failed under `fail`: run again it would process no children). One such job refuses the whole request. |
| `promote` | Lets a stuck parent run: every failed child that holds it back is treated as `ignore` (the failure is kept for `getIgnoredChildrenFailures()`, the edge dropped) and the parent is released. The children stay failed in the DLQ. | `flow_not_stuck` with `details.reason` `not_waiting`, `children_unfinished` (a child is waiting, delayed or active, so the parent is waiting, not stuck: the ids are listed) or `nothing_blocks`. |
| `remove` | Removes every job of the flow with its edges, kept failures, logs and the completion records of its children. Needs `confirm` equal to the root id (400 `confirmation_required`). | `flow_active`: a job is running (a worker holds it); `flow_too_large`: more than 1,000 jobs. |

`GET /flows` lists the flows (roots, newest first) with a count of jobs by state and `blocked`, the failed children that
hold a parent back. `GET /flows/:id` returns the jobs of one flow, top level first, at most `limit` of them (default 1,000,
at most 5,000): `truncated` says the flow has more, and `total` is the count up to 50,000. A child that completed and was
removed (`removeOnComplete`) is shown as a node with `version: null` and `removed: true`; it is not in `total` or in the
state counts. The two reads and an action are separate statements, so the view is not one snapshot; the fence is what makes
an action safe against a view that moved on. A job read returns `flowRoot`, `parentId` and, on a single-job read only,
`childrenIds`; `dependsOn` is always empty.

### Replay safety

Submitting a flow again with the same custom id on the root returns the live flow, its root marked `duplicated`, and
creates nothing: a producer that retries after a timeout does not create two parents. A root without a custom id has no
identity, so a retry creates a second flow. `FlowError` when the live root vanished (finished and removed) before it
could be read.

### Other differences

- A child's failure flags (`failParentOnFailure` and the three others) are not shown in its `job.opts`: they live on
  the edge, in `qcloud_dependencies.on_failure`.
- Edges stay after a child completes, and a parent is ready when every edge has a completion record. The edges of a
  finished parent are history, and the completion sweep and retention may remove what they point to.
- A parent released after a cancel or a late failure is rung by the tick, not at once; one released by a completing
  or failing child is rung in the same call that finished it.
- `getFlow` takes `depth` and `maxChildren` and nothing else, as upstream's `GetFlowOpts` does.

## Workflow engine

`Engine`, `Workflow` and `defineWorkflow` of `qelay-cloud` (upstream `src/client/workflow/`, commit `c43442c9`). A
run is a row in `qcloud_workflow_executions`; every node of it (a step, a branch, a wait, a loop turn) is a job on the
engine queue `__wf:steps`, so the run moves on every transport that a `Queue` does. Every public name of upstream's
`Engine`, `Workflow` and `EngineOptions` is in a table below, none left out, and
`packages/sdk/test/workflow.compat.test.ts` keeps it so.

### Read these first

1. **Time is the database's, and the tick keeps it.** A `waitFor` timeout is a deadline column. Nothing in an engine
   process holds a timer for it: the maintenance tick (`packages/maintenance`, the `workflows` step) claims overdue
   waits and publishes a job that fails the gate. A timed wait therefore ends **late by up to one tick interval** plus
   the transport's delivery; `docs/limits.md` section 7 has the numbers and `QCLOUD_WORKFLOW_*`. Without a running tick a
   timed wait never ends (a signal still resumes it).
2. **The tick also repairs.** A run whose engine died shows no write for `recoverIdleMs` / `QCLOUD_WORKFLOW_IDLE_MS`
   (default 300,000 ms); the tick takes it with a version-checked write and publishes its node again. A running node
   writes its run every `heartbeatMs` (default 10,000), so a slow step is not taken. A job whose bell a closing or
   crashed worker spent is re-rung by the tick too. Set the idle time above the longest silence a healthy run can have.
3. **Steps run at least once, and never twice with the same attempt number.** A crash inside a step runs it again with
   the next attempt number and the **same idempotency key** (`ctx.idempotencyKey`); use the key for external effects.
   Compensation handlers are at-least-once too: `compensation:completed` is emitted before the outcome is stored, so a
   crash in that window runs the handler again with the same key. After the outcome is stored it never runs again.
4. **Every engine method that reads or writes is async.** `register`, `getExecution`, `cleanup`, `archive` and
   `getArchivedCount` return values synchronously upstream.
5. **The store compares versions.** Two engines (or an engine and the tick) that write the same run do not overwrite
   each other: the loser's write fails and its work for that run stops (`WorkflowExecutionClosedError`, internal).
6. **Unsupported means an error, not a no-op.** `embedded`, `dataPath`, `connection` and Qelay's other connection
   options throw `UnsupportedOptionError`; a `transport` is required.

### `Engine`

| Method | Status | Notes |
| ------ | ------ | ----- |
| `constructor(opts)` | Differs | Takes `transport` (required), `databaseUrl` or `database` or `store`, `namespace`, `logger`, `metrics` as a [`Queue`](#constructor-and-connection-options) does, plus `queueName` (default `__wf:steps`; the tick must be told the same name), `concurrency` (default 5), `onEvent`, and the additions `clock`, `recoverIdleMs` and `heartbeatMs`. The engine opens its own pool unless a `store` is passed. |
| `register(workflow)` | Differs | **Async.** Refuses with `WorkflowDefinitionMismatchError` when a live run of the same name was started under a different definition (a rolling deploy with a changed definition), so an old run is never driven by new code. A run parked in `compensation-stuck` does not block it. Register children before a parent that names them. |
| `start(name, input?)` | Differs | The run is stored and its first node published before the call returns `{ id, workflowName }`; a publish failure is repaired by the tick. An unregistered name rejects with upstream's message (`Workflow "x" not registered`). |
| `getExecution(id)` | Differs | Async. `null` for an unknown id. |
| `signal(id, event, payload?)` | Differs | Async and valid from any process. First delivery wins, a second throws `was already received`; a run that is not waiting for it throws `cannot receive the signal`. Exactly one of several concurrent callers resumes a parked run. |
| `resumeCompensation(id)` | Supported | Retries the reversal that parked a `compensation-stuck` run. A parent whose sub-workflow is still live stays parked: a live child cannot be rolled back; let it stop, then resume. |
| `abandonCompensation(id)` | Supported | Records the remaining steps as `compensation-skipped` and ends the run `failed` with `rollbackStatus: 'stuck'`. |
| `recover(options?)` | Differs | `{ idleMs?, limit? }`. Takes over runs that showed no progress for `idleMs`: `running` runs are published again at their node, `compensating` and `failed` ones continue their unwind, and a `waiting` run is resumed if its signal arrived or expired if its deadline passed. The tick does the same for `running`, `compensating` and `failed` runs by itself, but **not** for `waiting` ones: a signal that was stored but whose resume was never published is repaired only by `recover()`. |
| `on`, `onAny`, `off`, `offAny`, `subscribe(id, fn)` | Supported | Events are emitted in the process that runs the node; an engine does not see the events of another process's nodes. The fifteen types are unchanged (`workflow:*`, `step:*`, `signal:*`, `compensation:*`). |
| `cleanup(maxAgeMs, states?)`, `archive(maxAgeMs, states?)` | Differs | Async, with an optional third `limit` (default 1,000; call again until fewer come back). `states` defaults to `completed` and `failed`; the cutoff is on the last write and is inclusive. |
| `getArchivedCount()` | Differs | Async. A full count of the archive table. |
| `close(force?)` | Differs | Closes the worker, the queue and a pool the engine opened; never the transport. `force` abandons running nodes: their jobs go back to `waiting` and the tick re-rings them (a surviving engine takes them after `reRingAfterMs`). |
| `startWorkflow(name, input?)` | New | The same as `start`, under the name the SDK documents. |
| `cancel(id, reason?)` | New | Stops a live run (`failed`, with the reason) and rolls back what it completed. A run that is already terminal throws. |
| `listExecutions(workflowName?, state?, options?)` | New | Newest first. `options` is `{ limit (default 100, at most 1,000), offset }`. |

### `Workflow` and `defineWorkflow`

| Name | Status | Notes |
| ---- | ------ | ----- |
| `constructor(name, { revision? })`, `seal()` | Supported | The sealed definition hashes the graph and the revision; a run is bound to the hash. |
| `step(name, handler, options?)` | Supported | `retry` (default 3), `timeout` (default 30,000 ms), `compensate`, `inputSchema`, `outputSchema`. A step that failed after it declared `compensate` is compensated as well. |
| `branch(condition)`, `path(name, builder)` | Supported | |
| `parallel(builder)` | Supported | Steps of one group run as separate node jobs. |
| `subWorkflow(name, inputMapper, { timeout, pollInterval })` | Differs | Defaults 300,000 and 100 ms as upstream. The parent's node job **polls the child and holds a worker slot** until it ends, so `concurrency` bounds the sub-workflows waiting at once. A child that outlives `timeout` fails the node; the parent then parks in `compensation-stuck` (a live child cannot be rolled back) until an operator lets the child stop and calls `resumeCompensation`. |
| `waitFor(event, { timeout? })` | Differs | The deadline is stored and ended by the tick (see above). A signal that arrives first wins. |
| `doUntil`, `doWhile`, `forEach`, `map` | Supported | `map`'s transform may run again after a crash in a later engine generation (at-least-once), as a step does. |
| `pivot()` | Supported | A run that crossed it is not rolled back (`rollbackStatus: 'not-applicable'`). |
| `getStepNames()`, `getIndexedStepNames()` | Supported | |
| `defineWorkflow(name, { revision? })` | New | `new Workflow(name, options)`. |

### `EngineOptions` and the rest of the upstream surface

| Name | Status | Notes |
| ---- | ------ | ----- |
| `queueName`, `concurrency`, `onEvent` | Supported | See the constructor. |
| `embedded`, `dataPath`, `connection` | Not supported | Throw `UnsupportedOptionError`. There is no embedded SQLite store and no TCP client; the runs are in Postgres and the jobs travel on the `transport`. |
| `setClock`, `resetClock`, `simulatedClock`, `clock()` (the process-global clock) | Not supported | Replaced by the `clock` option of the `Engine`: a `Clock` (`now`, `setTimeout`, `clearTimeout`, `random`, `randomBytes`) per engine. A wait's deadline is not read from it: the database's clock decides when a wait is due. |
| `WorkflowStore` (the SQLite store class) | Not supported | Replaced by `WorkflowStorePort` in `@qelay-cloud/core` and the Postgres implementation in `@qelay-cloud/store-postgres`. A run is stored through the codec, each encoded column is capped at 16 MiB and cyclic references are not kept. |
| The agent's and the panel's workflow routes | Differs | The Control API serves `GET /workflows`, `GET /workflows/executions/:id`, its steps, and one `POST /workflows/executions/:id/actions`; the panel has a Workflows page. Operator actions are version-checked requests that a worker holding the definition carries out, see [Operating workflows](#operating-workflows-from-the-control-api-and-the-panel). Upstream's agent routes are not reproduced. |

Where a workflow behaves differently from upstream and the difference is not a method, it is listed here: a run's id is
random and opaque, `Execution.version` is new (the compare-and-set counter), a `failed` run may be visible without
`rollbackStatus` for the moment between the failure being stored and the unwind being recorded, and `Execution` timestamps
are the engine's clock while the deadline of a wait is the database's.

### Operating workflows from the Control API and the panel

`GET /workflows` lists the definitions that workers announced (`announceMs`, 30 s by default, so a definition is "served"
for `QCLOUD_API_WORKFLOW_SERVED_MS`, 120,000 ms by default, after the last announcement) and the executions, newest
first. `GET /workflows/executions/:id` returns the run, its definition, a first page of steps, its children and the
state of its rollback; `GET /workflows/executions/:id/steps` pages the steps (`limit`, `offset`, `status`, `name` and
`iterationOf`). A for-each or map is one entry with counts by status; its iterations (`<step>:<n>`) are read a page at
a time. `features.workflows` in `GET /capabilities` is true when the database is at migration 10 or later (the definitions
workers announce; migration 11 adds the index behind the unserved-definition warning) and `QCLOUD_API_WORKFLOWS` is not
`false`; the panel hides the page otherwise. Both migrations only add a table or an index, so a release that does not know
them runs unchanged.

The Control API holds no definitions and runs no engine, so it never executes a step. An action is two parts: a **claim**
(a write checked against the `version` the caller read, answered with 409 `version_conflict` and nothing changed when the
run moved) and a **publish** (a `wf:step` job on `QCLOUD_WORKFLOW_QUEUE`, which a worker that has the definition
carries out). The actions are `signal`, `cancel`, `retry-compensation`, `abandon-compensation` and `recover`, all
`operator` role, all audited as `POST /workflows/executions/:id/actions` with the action name in the target and never the
payload, the event or the reason. `cancel` and `abandon-compensation` are destructive and take the run id as `confirm`.
A run that has ended is refused (`execution_terminal`), and so is an action that does not fit its state (`execution_state`).
`recover` takes one stuck run by hand, as the tick would, and refuses a run that showed progress within
`QCLOUD_WORKFLOW_IDLE_MS` (`workflow_progressing`); it also covers a `waiting` run whose awaited signal is already
recorded, which the tick does not look at. "Rollback" in the panel means `cancel` for a live run and `retry-compensation` for one whose
rollback stopped. If the claim succeeded and the publish failed the answer is 503 `publish_failed` with `claimed: true`,
and the maintenance tick publishes the job again once the run has been quiet for the idle window.

Differences from the SDK: `signal`, `retry-compensation` and `abandon-compensation` check `expectedVersion` as a read
only (the store takes its own row lock for them), so a run that moved between the check and the write is judged by the
store; a step's `result` and `error`, a run's `input`, `output` and a signal's payload are shown as stored, cut at a byte
budget with the same `{ "$type": "truncated" }` marker the job inspector uses. **The panel shows payloads to every
`viewer`**, so a workflow that carries secrets in its input shows them to everyone who may open the panel.

## Switching a producer

An existing Qelay producer changes its import and the construction of its `Queue`, and awaits what it did not:

```ts
// before
import { Queue } from 'qelay';
const queue = new Queue('telemetry', { connection: { host, port } });

// after
import { Queue } from 'qelay-cloud';
const queue = new Queue('telemetry', { databaseUrl, transport, namespace: 'prod' });
```

The producer halves of `examples/mqtt-bridge` and `examples/postgres-multibroker` of the upstream repository run this
way: `packages/sdk/test/queue.replay.test.ts` replays them. A `FlowProducer` changes the same way (`databaseUrl`,
`transport`, `namespace`); read the [`FlowProducer`](#flowproducer) section for the 1,000-job limit and the policy rules
before moving a flow. The step-by-step guide is [Moving from Qelay](migration.md).

## Switching a consumer

An existing Qelay worker changes its import and the construction of its `Worker`, and adds the transport:

```ts
// before
import { Worker } from 'qelay';
const worker = new Worker('telemetry', async (job, { signal }) => handle(job.data, signal), {
  connection: { host, port },
  concurrency: 8,
});

// after
import { Worker } from 'qelay-cloud';
const worker = new Worker('telemetry', async (job, { signal }) => handle(job.data, signal), {
  databaseUrl, transport, namespace: 'prod', concurrency: 8,
});
process.on('SIGTERM', () => void worker.close());
```

Check, in this order: the options your worker passes against the [Options](#options) table (an unsupported one throws by
name); what the processor reads from `job` against [Processor](#processor); and the behaviours under
[Read these first](#read-these-first-1), the delay of a rate-limited or backed-off job above all. Listeners of
`QueueEvents` read `completed` without `returnvalue` and `delayed` without `delay`.
