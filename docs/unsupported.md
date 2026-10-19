# What is not in Qelay-Cloud

> Generated from [compat.md](compat.md) by `bun run docs:check --write`. Do not edit it by hand: change the source.

Qelay-Cloud covers the BullMQ-style core of Qelay (decision D6) on managed queues. Each entry below either throws
`UnsupportedOptionError` naming the option, answers `501 not_supported` from the Control API, or is a method that does
not exist on the class. **Nothing is ignored silently.** [Moving from Qelay](migration.md) says what to change first.

## At a glance

| Part of the API | Supported | Differs | New | Not supported |
| --- | ---: | ---: | ---: | ---: |
| [Constructor and connection options](compat.md#constructor-and-connection-options) | 1 | 0 | 7 | 5 |
| [`Queue` methods](compat.md#queue-methods) | 10 | 27 | 0 | 21 |
| [Job](compat.md#job) | 4 | 3 | 1 | 1 |
| [Job options](compat.md#job-options) | 2 | 0 | 0 | 5 |
| [`Worker`](compat.md#worker) | 11 | 11 | 7 | 16 |
| [`QueueEvents`](compat.md#queueevents) | 3 | 9 | 8 | 3 |
| [`FlowProducer`](compat.md#flowproducer) | 2 | 4 | 0 | 1 |
| [Workflow engine](compat.md#workflow-engine) | 11 | 12 | 4 | 3 |
| **All** | 44 | 66 | 27 | 55 |

Supported: same name, arguments and result. Differs: same name, and compat.md states the difference. New: exists here
and not upstream. Not supported: listed below.

## Constructor and connection options

Table: [compat.md](compat.md#constructor-and-connection-options).

| Feature | Why, and what to do instead |
| --- | --- |
| `connection` | Upstream selects a TCP or shared connection with it. Use `databaseUrl` or `database`. |
| `host`, `port` | The Qelay TCP server does not exist here. |
| `embedded`, `dataPath` | Embedded mode is a SQLite-in-process engine. There is none. |
| `autoBatch` | No client-side batching by default: `addBulk` is one transaction. Qelay-Cloud's own `groupCommit` queue option (off by default) lets concurrent `add` calls share one. |
| `prefixKey` | Namespacing is `namespace`; the tables are `qcloud_*`. |

## `Queue` methods

Table: [compat.md](compat.md#queue-methods).

| Feature | Why, and what to do instead |
| --- | --- |
| `getChildrenValues(id)` | Read it through the job: `(await queue.getJob(id))?.getChildrenValues()`. See [`FlowProducer`](compat.md#flowproducer). |
| `extendJobLock(id, token, duration)` | A job's lease belongs to the `Worker` that holds it, which renews it by itself; a producer has no token. |
| `retryJob(id)`, `retryJobs(opts?)` | A failed job is retried by the store's retry rules (`attempts`, `backoff`) or lands in the DLQ. Manual retry of a failed job needs the version precondition of task 14 (k) and is a v1.1 candidate. |
| `getCountsPerPriority`, `getCountsPerPriorityAsync` | There is no read model of counts per priority; it would be a scan. |
| `getCountsPerPriorityForGroup` | Group methods: see [Groups](compat.md#groups). |
| `retryDlq`, `retryDlqAsync`, `retryDlqByFilter`, `retryDlqByFilterAsync` | **DLQ retry is closed, fail-closed**, as the Phase 0 gate decided (task 14 (k)): reopening it needs the `version` precondition and an entry fence, a v1.1 candidate. |
| `retryCompleted`, `retryCompletedAsync` | Same reason: re-running a finished job needs the same precondition. Add a new job instead. |
| `rateLimit(expireTimeMs)`, `getRateLimitTtl()`, `isMaxed()` | These belong to a running worker (a handler asking the queue to back off), and the store has no time-boxed rate limit to ask. Use `setGlobalRateLimit`. |
| `getGroupJobsCount`, `getGroupsJobsCount`, `getGroupActiveCount`, `getGroupJobs`, `getCountsPerPriorityForGroup` | The `group` **job option** is supported (`{ id, maxSize?, priority? }`), and claims honor the group state the store keeps. There is no store facet that reads or writes group state for a producer yet; a v1.1 candidate. |
| `setGroupRateLimit`, `getGroupRateLimit`, `removeGroupRateLimit`, `getGroupRateLimitTtl` | Same. |
| `setGroupConcurrency`, `getGroupConcurrency`, `removeGroupConcurrency` | Same. |
| `pauseGroup`, `resumeGroup`, `isGroupPaused` | Same. |
| `upsertJobScheduler`, `removeJobScheduler`, `getJobScheduler`, `getJobSchedulers`, `getJobSchedulersCount` | Qelay's job schedulers are repeat jobs (`repeat` option), which D6 leaves out of v1.0.0. Cron schedules exist in the store (`store.crons`, used by the tick) but have no producer API here. A v1.1 candidate. |
| `getDeduplicationJobId(key)` | The `deduplication` **job option** is supported (`{ id, ttl? }`, with the `duplicated` marker on the result). The store has no facet that looks a key up or releases it; a v1.1 candidate. |
| `removeDeduplicationKey(key)` | Same. |
| `moveJobToCompleted`, `moveJobToFailed`, `moveJobToWait`, `moveJobToDelayed` | These move an **active** job for the worker that holds its lease. The `Worker` (task 19) does it with a lease token; a `Queue` never holds one. |
| `moveJobToWaitingChildren`, `waitJobUntilFinished` | `moveJobToWaitingChildren` moves an active job for the worker that holds its lease, and a flow parent is written `waiting-children` by `FlowProducer.add` instead. To wait for a job, listen to a [`QueueEvents`](compat.md#queueevents) for its `completed` or `failed`, or poll `getJobState`. |
| `getJobDependencies`, `getJobDependenciesCount`, `getDependencies` | Read them through the job: `job.getDependencies()` returns `{ processed, unprocessed }`; there is no count and no paging, because a flow has at most 1,000 jobs. See [`FlowProducer`](compat.md#flowproducer). |
| `forward(options)` | `Forwarder` is outside v1.0.0 (D6). |
| `trimEvents(...)` | The journal is trimmed by the tick's retention rules, not by a producer. |
| `getMetrics(type, start, end)` | The panel reads throughput through the store's read models. A v1.1 candidate for the SDK. |

## Job

Table: [compat.md](compat.md#job).

| Feature | Why, and what to do instead |
| --- | --- |
| `retry`, `extendLock`, `token`, `parent`, `stacktrace`, `repeatJobKey`, `moveTo*` | Not part of the v1.0.0 subset; see the queue methods above. |

## Job options

Table: [compat.md](compat.md#job-options).

| Feature | Why, and what to do instead |
| --- | --- |
| `repeat`, `debounce` | (D6) |
| `durable` | Qelay's durable-write flag has no meaning when Postgres is the store; the upstream multibroker example passes `{ durable: true }`, so drop it. |
| `parent`, `failParentOnFailure`, `removeDependencyOnFailure`, `continueParentOnFailure`, `ignoreDependencyOnFailure` | on `Queue.add`: `UnsupportedOptionError`, "belongs to a flow". They are the options of a [`FlowProducer`](compat.md#flowproducer) flow, which sets the parent itself; the four flags are supported there on a child. |
| `keepLogs`, `stackTraceLimit`, `sizeLimit`, `timestamp` |  |
| Any other key | `UnsupportedOptionError`, `'is unknown'` |

## `Worker`

Table: [compat.md](compat.md#worker).

| Feature | Why, and what to do instead |
| --- | --- |
| `opts`, `progress`, `getState()`, `isFailed()` and the other `is*` methods, `updateData`, `retry`, `promote`, `remove`, `moveTo*`, `extendLock`, `token`, `parent`, `getChildrenValues` | A processor receives the claimed job, not a `Job` read from the store. Read it through a `Queue` when you need more. |
| An `ObservableLike` return value | Return a value or a promise. |
| `connection`, `host`, `port`, `embedded`, `dataPath`, `prefixKey` | As on the `Queue`. |
| `batchSize`, `pollTimeout`, `drainDelay` | The worker waits for bells and does not poll. A bell claims as many jobs as the free slots allow. |
| `useLocks`, `skipLockRenewal` | A job is always leased and renewed. |
| `skipStalledCheck`, `maxStalledCount` | Recovery is the tick's, not the worker's. The limit is per queue: `queue.setStallConfig({ maxStalls })`. |
| `limiter` | A rate limit is the queue's and holds across workers: `queue.setGlobalRateLimit`. |
| `batch` | Batch processing is not supported. |
| `removeOnComplete`, `removeOnFail` | Give them to the job: `JobOptions.removeOnComplete`, `removeOnFail`. |
| `closing` | Keep the promise `close()` returns. |
| `cancelJob(id, reason?)`, `cancelAllJobs(reason?)`, `isJobCancelled(id)` | Stop work through the processor's `signal`; it aborts when the lease is lost and when `close` runs out of grace. |
| `rateLimit(ms)`, `isRateLimited()`, `getRateLimiterInfo()`, `rateLimitGroup(job, duration)`, `Worker.RateLimitError()` | Rate limits belong to the queue (`setGlobalRateLimit`) and to groups (`group.limit`). |
| `startStalledCheckTimer()` | Recovery is the tick's. |
| `delay(ms?, abortController?)` | An internal helper upstream. |
| `getNextJob(token?, opts?)`, `processJobManually(...)`, `extendJobLocks(ids, tokens, duration)` | Manual processing is outside v1.0.0. |
| `cancelled` | There is no cancellation. |

## `QueueEvents`

Table: [compat.md](compat.md#queueevents).

| Feature | Why, and what to do instead |
| --- | --- |
| `connection`, `embedded`, `dataPath`, `prefixKey` | As on the `Queue`. |
| `emitError(error)` | An internal method upstream. |
| `retried`, `drained`, `paused`, `resumed` | A retried attempt is a `failed` with `terminal: false`; `drained` is the `Worker`'s event; pausing and resuming are not journaled. |

## `FlowProducer`

Table: [compat.md](compat.md#flowproducer).

| Feature | Why, and what to do instead |
| --- | --- |
| `addChain`, `addBulkThen`, `addTree`, `getParentResult`, `getParentResults` | Upstream's legacy flow API (`FlowStep`, `FlowResult`). Use `add` with `children`; read results with `job.getChildrenValues()`. |

## Workflow engine

Table: [compat.md](compat.md#workflow-engine).

| Feature | Why, and what to do instead |
| --- | --- |
| `embedded`, `dataPath`, `connection` | Throw `UnsupportedOptionError`. There is no embedded SQLite store and no TCP client; the runs are in Postgres and the jobs travel on the `transport`. |
| `setClock`, `resetClock`, `simulatedClock`, `clock()` (the process-global clock) | Replaced by the `clock` option of the `Engine`: a `Clock` (`now`, `setTimeout`, `clearTimeout`, `random`, `randomBytes`) per engine. A wait's deadline is not read from it: the database's clock decides when a wait is due. |
| `WorkflowStore` (the SQLite store class) | Replaced by `WorkflowStorePort` in `@qelay-cloud/core` and the Postgres implementation in `@qelay-cloud/store-postgres`. A run is stored through the codec, each encoded column is capped at 16 MiB and cyclic references are not kept. |
