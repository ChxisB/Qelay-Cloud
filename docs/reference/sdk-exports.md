# SDK exports

> Generated from the TSDoc of [packages/sdk/src/index.ts](../../packages/sdk/src/index.ts) by `bun run docs:check --write`.
> Do not edit it by hand: change the source.

The 103 names `import ... from 'qelay-cloud'` gives you. What each `Queue`, `Worker`, `QueueEvents` and
`FlowProducer` method does, and how it differs from Qelay, is in [compat.md](../compat.md); the workflow engine is its
last section. A name with no summary has no TSDoc on its declaration: read the signature in the file named.

| Name | Kind | Defined in | Summary |
| --- | --- | --- | --- |
| `ActiveEvent` | interface | [packages/sdk/src/queueEventTypes.ts](../../packages/sdk/src/queueEventTypes.ts) |  |
| `BatchProcessor` | type | [packages/sdk/src/workerOptions.ts](../../packages/sdk/src/workerOptions.ts) | What a worker with `batch` runs: up to `size` jobs at once. Return nothing to complete every job, or an array with one entry per job, in order: an `Error` entry fails that job, anything else is its result. A throw, or any other return, fails every job. Each job keeps its own lease, attempts and backoff. `context.signal` aborts when the worker closes out of its grace or every job's lease is lost; a job whose lease is lost alone is dropped from the outcome and its entry is ignored. |
| `BatchWorkerOptions` | type | [packages/sdk/src/workerOptions.ts](../../packages/sdk/src/workerOptions.ts) | The options of a worker that runs a `BatchProcessor`. |
| `BranchCondition` | type | [packages/sdk/src/workflow/stepTypes.ts](../../packages/sdk/src/workflow/stepTypes.ts) | Branch condition function |
| `BulkJob` | interface | [packages/sdk/src/add.ts](../../packages/sdk/src/add.ts) |  |
| `CleanupOptions` | interface | [packages/sdk/src/workflow/engineTypes.ts](../../packages/sdk/src/workflow/engineTypes.ts) |  |
| `Clock` | interface | [packages/sdk/src/workflow/clock.ts](../../packages/sdk/src/workflow/clock.ts) |  |
| `CompensateHandler` | type | [packages/sdk/src/workflow/stepTypes.ts](../../packages/sdk/src/workflow/stepTypes.ts) | Compensate handler (type-erased for internal storage) |
| `CompensationOutcome` | interface | [packages/core/src/workflowTypes.ts](../../packages/core/src/workflowTypes.ts) |  |
| `CompensationStatus` | type | [packages/core/src/workflowTypes.ts](../../packages/core/src/workflowTypes.ts) | Terminal outcome of one step's rollback. |
| `CompletedEvent` | interface | [packages/sdk/src/queueEventTypes.ts](../../packages/sdk/src/queueEventTypes.ts) | The journal records no return value: read it with `queue.getJob(jobId)`. |
| `DEFAULT_JOBS_END` | constant | [packages/sdk/src/read.ts](../../packages/sdk/src/read.ts) |  |
| `DEFAULT_NAMESPACE` | constant | [packages/sdk/src/options.ts](../../packages/sdk/src/options.ts) |  |
| `defineWorkflow` | function | [packages/sdk/src/workflow/index.ts](../../packages/sdk/src/workflow/index.ts) | Start a workflow definition: the same as `new Workflow(name, options)`. |
| `DelayedEvent` | interface | [packages/sdk/src/queueEventTypes.ts](../../packages/sdk/src/queueEventTypes.ts) |  |
| `DlqConfig` | interface | [packages/sdk/src/config.ts](../../packages/sdk/src/config.ts) |  |
| `DlqFilter` | interface | [packages/sdk/src/config.ts](../../packages/sdk/src/config.ts) |  |
| `DuplicatedEvent` | interface | [packages/sdk/src/queueEventTypes.ts](../../packages/sdk/src/queueEventTypes.ts) |  |
| `Engine` | class | [packages/sdk/src/workflow/engine.ts](../../packages/sdk/src/workflow/engine.ts) |  |
| `EngineOptions` | interface | [packages/sdk/src/workflow/engineTypes.ts](../../packages/sdk/src/workflow/engineTypes.ts) | What an `Engine` is built from: the store and the doorbell as for a `Queue`, plus the engine's own knobs. Qelay's `connection`, `embedded` and `dataPath` throw (see docs/compat.md). |
| `EventStart` | type | [packages/sdk/src/queueEventTypes.ts](../../packages/sdk/src/queueEventTypes.ts) | Where a `QueueEvents` starts reading. |
| `Execution` | interface | [packages/core/src/workflowTypes.ts](../../packages/core/src/workflowTypes.ts) | Full persisted execution state |
| `ExecutionListOptions` | interface | [packages/core/src/workflowTypes.ts](../../packages/core/src/workflowTypes.ts) | Stable, bounded pagination for execution listings. |
| `ExecutionState` | type | [packages/core/src/workflowTypes.ts](../../packages/core/src/workflowTypes.ts) | Execution state |
| `FailedEvent` | interface | [packages/sdk/src/queueEventTypes.ts](../../packages/sdk/src/queueEventTypes.ts) |  |
| `FlowJob` | interface | [packages/sdk/src/flowTypes.ts](../../packages/sdk/src/flowTypes.ts) | One job of a flow and the jobs that must finish before it runs, in Qelay's shape (`FlowJob`). A child sets what its failure does to its parent through the options `failParentOnFailure`, `continueParentOnFailure`, `ignoreDependencyOnFailure` and `removeDependencyOnFailure`. |
| `FlowOpts` | interface | [packages/sdk/src/flowTypes.ts](../../packages/sdk/src/flowTypes.ts) | Per-call options of `FlowProducer.add` and `addBulk`. |
| `FlowProducer` | class | [packages/sdk/src/flowProducer.ts](../../packages/sdk/src/flowProducer.ts) | Adds flows: a parent job that waits for its children, which may be parents themselves, in any queues of the namespace. Qelay's `FlowProducer` over Postgres: a flow is written in one transaction, so either all of its jobs exist or none do, and its parent is never claimable before its last child is done. `docs/compat.md` lists what is supported and what differs. |
| `FlowProducerOptions` | type | [packages/sdk/src/flowTypes.ts](../../packages/sdk/src/flowTypes.ts) | A `FlowProducer` is built from what a `Queue` is: a database, a doorbell and a namespace. |
| `FlowReads` | interface | [packages/sdk/src/flowOps.ts](../../packages/sdk/src/flowOps.ts) | What a job that has children reads about them, on `Job` and on the job a processor receives. Each is one query; a job with no children, or an unknown one, reads as empty. Keys are `"<queue>:<id>"`. |
| `ForEachDefinition` | interface | [packages/sdk/src/workflow/stepTypes.ts](../../packages/sdk/src/workflow/stepTypes.ts) | Definition of a forEach loop (type-erased) |
| `ForEachItemsExtractor` | type | [packages/sdk/src/workflow/stepTypes.ts](../../packages/sdk/src/workflow/stepTypes.ts) | Item extractor for forEach |
| `GetFlowOpts` | interface | [packages/sdk/src/flowTypes.ts](../../packages/sdk/src/flowTypes.ts) | What `FlowProducer.getFlow` reads. |
| `GetJobsOptions` | interface | [packages/sdk/src/read.ts](../../packages/sdk/src/read.ts) |  |
| `Job` | interface | [packages/sdk/src/job.ts](../../packages/sdk/src/job.ts) | A job as `Queue.add` and the reads return it: the fields Qelay's `Job` has for the supported subset, and the instance methods of that subset, each running through the store. Fields are a snapshot taken when the job was read; `getState()` reads again. A flow parent also reads its children (`getChildrenValues`, `getDependencies`, `getFailedChildrenValues`, `getIgnoredChildrenFailures`). What is not here (`retry`, `extendLock`, `token`, `parent`, `stacktrace`, `repeatJobKey`) is listed in `docs/compat.md`. |
| `JobCounts` | interface | [packages/sdk/src/read.ts](../../packages/sdk/src/read.ts) | Qelay's `getJobCounts` result. |
| `JobLogs` | interface | [packages/sdk/src/config.ts](../../packages/sdk/src/config.ts) |  |
| `JobNode` | interface | [packages/sdk/src/flowTypes.ts](../../packages/sdk/src/flowTypes.ts) | A job of an added or read flow, with the nodes of its children. `children` is absent for a leaf. |
| `JobStateName` | type | [packages/sdk/src/jobOps.ts](../../packages/sdk/src/jobOps.ts) | What one job accepts, by id. Job ids are unique per namespace, not per queue, so each operation first checks that the job belongs to this queue: a `Queue` never sees or changes another queue's job. That is one read before the write; the job's queue cannot change, so only a job removed and re-created under the same custom id in another queue between the two could be missed. |
| `JobWorkerOptions` | type | [packages/sdk/src/workerOptions.ts](../../packages/sdk/src/workerOptions.ts) | The options of a worker that runs one job per call; `batch` is what tells the two constructors apart. |
| `Logger` | interface | [packages/sdk/src/options.ts](../../packages/sdk/src/options.ts) | Receives what the SDK swallows on purpose, such as a ring that failed after the job was admitted. |
| `LoopCondition` | type | [packages/sdk/src/workflow/stepTypes.ts](../../packages/sdk/src/workflow/stepTypes.ts) | Loop condition: receives context + iteration count, returns boolean |
| `LoopDefinition` | interface | [packages/sdk/src/workflow/stepTypes.ts](../../packages/sdk/src/workflow/stepTypes.ts) | Definition of a doUntil/doWhile loop (type-erased) |
| `MapDefinition` | interface | [packages/sdk/src/workflow/stepTypes.ts](../../packages/sdk/src/workflow/stepTypes.ts) | Definition of a map node (type-erased) |
| `MapTransformFn` | type | [packages/sdk/src/workflow/stepTypes.ts](../../packages/sdk/src/workflow/stepTypes.ts) | Transform function for map |
| `Metrics` | interface | [packages/sdk/src/options.ts](../../packages/sdk/src/options.ts) | A counter sink. Names are listed in `docs/compat.md`; every one starts with `qcloud.`. |
| `ObliteratedEvent` | interface | [packages/sdk/src/queueEventTypes.ts](../../packages/sdk/src/queueEventTypes.ts) |  |
| `ParallelDefinition` | interface | [packages/sdk/src/workflow/stepTypes.ts](../../packages/sdk/src/workflow/stepTypes.ts) | Definition of a parallel step group |
| `Processor` | type | [packages/sdk/src/workerOptions.ts](../../packages/sdk/src/workerOptions.ts) |  |
| `ProcessorContext` | interface | [packages/sdk/src/workerOptions.ts](../../packages/sdk/src/workerOptions.ts) | What a processor receives after its job, as in Qelay's `ProcessorContext`. |
| `ProgressEvent` | interface | [packages/sdk/src/queueEventTypes.ts](../../packages/sdk/src/queueEventTypes.ts) |  |
| `Queue` | class | [packages/sdk/src/queue.ts](../../packages/sdk/src/queue.ts) | The producer and admin side of one queue of a Qelay-Cloud namespace: Qelay's `Queue` over Postgres, with a cloud queue as the doorbell. `docs/compat.md` lists each method of Qelay's `Queue` and says whether this one has it, has it differently, or does not. |
| `QueueEventListeners` | interface | [packages/sdk/src/queueEventTypes.ts](../../packages/sdk/src/queueEventTypes.ts) |  |
| `QueueEventMap` | interface | [packages/sdk/src/queueEventTypes.ts](../../packages/sdk/src/queueEventTypes.ts) | The event names `QueueEvents` emits, with the payload of each; `error` and `gap` are listed apart. |
| `QueueEvents` | class | [packages/sdk/src/queueEvents.ts](../../packages/sdk/src/queueEvents.ts) | The stream of what happens to the jobs of one queue, read from the event journal (`qcloud_events`) that `PostgresStore` writes in the same transaction as each change. Qelay's `QueueEvents`, with these differences (docs/compat.md): |
| `QueueEventsOptions` | interface | [packages/sdk/src/queueEvents.ts](../../packages/sdk/src/queueEvents.ts) |  |
| `QueueOptions` | interface | [packages/sdk/src/options.ts](../../packages/sdk/src/options.ts) | What a `Queue` is built from. Qelay's `host`, `port`, `embedded`, `connection`, `dataPath`, `autoBatch` and `prefixKey` are refused (see `rejectLegacyOptions`). |
| `QueuePolicy` | interface | [packages/core/src/queuePolicy.ts](../../packages/core/src/queuePolicy.ts) | What a queue gives a job that sets none of its own (DESIGN.md D17). Each setting is applied at enqueue and only to a job that left that setting out, so a job's own option always wins. Bounds are those of the job options. |
| `QueueRunWindow` | interface | [packages/core/src/queueWindow.ts](../../packages/core/src/queueWindow.ts) |  |
| `QueueRunWindowInput` | type | [packages/core/src/queueWindow.ts](../../packages/core/src/queueWindow.ts) | What a caller sends: the zone may be left out. |
| `QueueRunWindowState` | interface | [packages/core/src/queueWindow.ts](../../packages/core/src/queueWindow.ts) | A window and where it stands now: the interval that is open, or the next one to open. |
| `realClock` | constant | [packages/sdk/src/workflow/clock.ts](../../packages/sdk/src/workflow/clock.ts) |  |
| `RecoverResult` | interface | [packages/sdk/src/workflow/engineTypes.ts](../../packages/sdk/src/workflow/engineTypes.ts) | Result of `engine.recover()` and of the tick's recovery step. |
| `RemovedEvent` | interface | [packages/sdk/src/queueEventTypes.ts](../../packages/sdk/src/queueEventTypes.ts) |  |
| `RollbackStatus` | type | [packages/core/src/workflowTypes.ts](../../packages/core/src/workflowTypes.ts) | What the engine did after a failure, independently of the failure reason. |
| `RunHandle` | interface | [packages/sdk/src/workflow/engineTypes.ts](../../packages/sdk/src/workflow/engineTypes.ts) | What `startWorkflow` hands back. |
| `SchemaLike` | interface | [packages/sdk/src/workflow/stepTypes.ts](../../packages/sdk/src/workflow/stepTypes.ts) | Schema-like object — any object with a .parse() method (Zod, ArkType, Valibot, etc.) |
| `SignalEvent` | interface | [packages/sdk/src/workflow/eventTypes.ts](../../packages/sdk/src/workflow/eventTypes.ts) | Signal event payload |
| `StallConfig` | interface | [packages/sdk/src/config.ts](../../packages/sdk/src/config.ts) | Per-queue settings, the DLQ and the job logs. |
| `StalledEvent` | interface | [packages/sdk/src/queueEventTypes.ts](../../packages/sdk/src/queueEventTypes.ts) |  |
| `StepContext` | interface | [packages/sdk/src/workflow/stepTypes.ts](../../packages/sdk/src/workflow/stepTypes.ts) | Context passed to step handlers |
| `StepEvent` | interface | [packages/sdk/src/workflow/eventTypes.ts](../../packages/sdk/src/workflow/eventTypes.ts) | Step-level event payload |
| `StepHandler` | type | [packages/sdk/src/workflow/stepTypes.ts](../../packages/sdk/src/workflow/stepTypes.ts) | Step handler function (type-erased for internal storage) |
| `StepJobData` | type | [packages/sdk/src/workflow/engineTypes.ts](../../packages/sdk/src/workflow/engineTypes.ts) | The payload of one `wf:step` job: which node of which run to advance (defined in `core`, shared with the tick and the Control API). |
| `StepOptions` | interface | [packages/sdk/src/workflow/stepTypes.ts](../../packages/sdk/src/workflow/stepTypes.ts) | Options for a single step. |
| `StepRecord` | interface | [packages/core/src/workflowTypes.ts](../../packages/core/src/workflowTypes.ts) | Record of a step's execution |
| `StepState` | type | [packages/core/src/workflowTypes.ts](../../packages/core/src/workflowTypes.ts) | Step execution state |
| `SubWorkflowInputMapper` | type | [packages/sdk/src/workflow/stepTypes.ts](../../packages/sdk/src/workflow/stepTypes.ts) | Input mapper for sub-workflows |
| `SubWorkflowOptions` | interface | [packages/sdk/src/workflow/stepTypes.ts](../../packages/sdk/src/workflow/stepTypes.ts) | Bounds for polling a child workflow. |
| `TimerHandle` | interface | [packages/sdk/src/workflow/clock.ts](../../packages/sdk/src/workflow/clock.ts) | The engine's source of time and randomness, injected per engine. |
| `TraceHandle` | interface | [packages/sdk/src/options.ts](../../packages/sdk/src/options.ts) | What the code inside a span can tell it. |
| `TraceSpan` | interface | [packages/sdk/src/options.ts](../../packages/sdk/src/options.ts) | What a span says about itself. `jobId` is absent where the job does not exist yet (the add). |
| `Tracing` | interface | [packages/sdk/src/options.ts](../../packages/sdk/src/options.ts) | Opt-in tracing, off unless passed. `produce` runs `work` in a span and hands it the `traceparent` to store with the jobs; `consume` runs `work` in a span that continues the stored one (or starts a new trace for a job added without one). Both must call `work` once and return what it returns. `@qelay-cloud/telemetry` has an OpenTelemetry implementation. |
| `TypedCompensateHandler` | type | [packages/sdk/src/workflow/stepTypes.ts](../../packages/sdk/src/workflow/stepTypes.ts) | Typed compensate handler — preserves accumulated step types |
| `TypedStepHandler` | type | [packages/sdk/src/workflow/stepTypes.ts](../../packages/sdk/src/workflow/stepTypes.ts) | Typed step handler — preserves accumulated step types |
| `UnrecoverableError` | class | [packages/sdk/src/workerOptions.ts](../../packages/sdk/src/workerOptions.ts) | Throw it from a processor to fail the job for good, whatever attempts are left. Qelay's class of the same name; `job.discard()` does the same without throwing. |
| `WaitingChildrenEvent` | interface | [packages/sdk/src/queueEventTypes.ts](../../packages/sdk/src/queueEventTypes.ts) |  |
| `WaitingEvent` | interface | [packages/sdk/src/queueEventTypes.ts](../../packages/sdk/src/queueEventTypes.ts) | The payloads of `QueueEvents`, under Qelay's names. Where the journal knows less, a field is left out. |
| `Worker` | class | [packages/sdk/src/worker.ts](../../packages/sdk/src/worker.ts) | The consumer side of one queue: Qelay's `Worker` over Postgres, with a cloud queue as the doorbell. It turns bells into claimed, heartbeated, completed or failed jobs. |
| `WorkerBatchOptions` | interface | [packages/sdk/src/workerOptions.ts](../../packages/sdk/src/workerOptions.ts) |  |
| `WorkerCloseOptions` | interface | [packages/sdk/src/workerOptions.ts](../../packages/sdk/src/workerOptions.ts) |  |
| `WorkerEvents` | interface | [packages/sdk/src/workerOptions.ts](../../packages/sdk/src/workerOptions.ts) |  |
| `WorkerJob` | interface | [packages/sdk/src/workerOptions.ts](../../packages/sdk/src/workerOptions.ts) | What a processor receives: the claimed job and the calls that report on it while it runs. |
| `WorkerOptions` | interface | [packages/sdk/src/workerOptions.ts](../../packages/sdk/src/workerOptions.ts) | What a `Worker` is built from. The connection options are a `Queue`'s, without `defaultJobOptions`. |
| `Workflow` | class | [packages/sdk/src/workflow/workflow.ts](../../packages/sdk/src/workflow/workflow.ts) |  |
| `WorkflowDefinitionMismatchError` | class | [packages/sdk/src/workflow/definitionGuard.ts](../../packages/sdk/src/workflow/definitionGuard.ts) |  |
| `WorkflowEmitter` | class | [packages/sdk/src/workflow/emitter.ts](../../packages/sdk/src/workflow/emitter.ts) |  |
| `WorkflowEvent` | interface | [packages/sdk/src/workflow/eventTypes.ts](../../packages/sdk/src/workflow/eventTypes.ts) | Base event payload |
| `WorkflowEventListener` | type | [packages/sdk/src/workflow/eventTypes.ts](../../packages/sdk/src/workflow/eventTypes.ts) | Event listener function |
| `WorkflowEventType` | type | [packages/sdk/src/workflow/eventTypes.ts](../../packages/sdk/src/workflow/eventTypes.ts) | All workflow event types |
| `WorkflowExecutionClosedError` | class | [packages/sdk/src/workflow/executionFence.ts](../../packages/sdk/src/workflow/executionFence.ts) | Internal control-flow signal used to abandon work owned by a closed Engine. |
| `WorkflowLifecycleEvent` | interface | [packages/sdk/src/workflow/eventTypes.ts](../../packages/sdk/src/workflow/eventTypes.ts) | Workflow lifecycle event payload |
| `WorkflowNode` | type | [packages/sdk/src/workflow/stepTypes.ts](../../packages/sdk/src/workflow/stepTypes.ts) | Workflow node (discriminated union) |
