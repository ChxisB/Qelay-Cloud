/** Typed errors with stable `code` strings. Callers branch on `code`, never on message text. */

export type ErrorCode =
  | 'LEASE_LOST'
  | 'JOB_NOT_FOUND'
  | 'QUEUE_PAUSED'
  | 'UNSUPPORTED_OPTION'
  | 'TRANSPORT_ERROR'
  | 'STORE_ERROR'
  | 'OPERATION_DEADLINE'
  | 'OUTCOME_UNKNOWN'
  | 'ILLEGAL_TRANSITION'
  | 'FLOW_PROTECTED'
  | 'FLOW_INVALID'
  | 'JOB_STATE'
  | 'JOB_VERSION'
  | 'EXECUTION_STALE'
  | 'EXECUTION_EXISTS'
  | 'SIGNAL_REJECTED';

export abstract class QcloudError extends Error {
  abstract readonly code: ErrorCode;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A write carried a token that no longer holds the job. Nothing was changed. */
export class LeaseLostError extends QcloudError {
  readonly code = 'LEASE_LOST';
  constructor(readonly jobId: string) {
    super(`lease on job ${jobId} is no longer held`);
  }
}

export class JobNotFoundError extends QcloudError {
  readonly code = 'JOB_NOT_FOUND';
  constructor(readonly jobId: string) {
    super(`job ${jobId} not found`);
  }
}

export class QueuePausedError extends QcloudError {
  readonly code = 'QUEUE_PAUSED';
  constructor(readonly queue: string) {
    super(`queue ${queue} is paused`);
  }
}

/** An option outside the supported subset (D6). Raised so nothing is silently ignored. */
export class UnsupportedOptionError extends QcloudError {
  readonly code = 'UNSUPPORTED_OPTION';
  constructor(
    readonly option: string,
    reason = 'is not supported'
  ) {
    super(`option "${option}" ${reason}`);
  }
}

export class TransportError extends QcloudError {
  readonly code = 'TRANSPORT_ERROR';
}

export class StoreError extends QcloudError {
  readonly code = 'STORE_ERROR';
}

/**
 * A store call hit its deadline. The outcome is unknown: the write may or may not have been applied.
 * Every write is guarded by lease token or `version`, so the caller may retry it or drop it
 * without a double effect.
 */
export class OperationDeadlineError extends QcloudError {
  readonly code = 'OPERATION_DEADLINE';
  constructor(
    readonly operation: string,
    readonly deadlineMs: number
  ) {
    super(`${operation} exceeded its ${deadlineMs} ms deadline; the outcome is unknown`);
  }
}

/**
 * A worker wrote a job's completion, failure or release, the write threw, and the retry could not
 * say whether the first one landed. Nothing was reported as done; the job's state in the database
 * is the truth, and its lease, if it still holds one, is recovered by the tick.
 */
export class OutcomeUnknownError extends QcloudError {
  readonly code = 'OUTCOME_UNKNOWN';
  constructor(
    readonly jobId: string,
    readonly operation: 'complete' | 'fail' | 'release',
    cause?: unknown
  ) {
    super(`${operation} of job ${jobId} was not confirmed; its state is unknown`, { cause });
  }
}

export class IllegalTransitionError extends QcloudError {
  readonly code = 'ILLEGAL_TRANSITION';
  constructor(
    readonly cause_: string,
    readonly from: string,
    readonly to: string
  ) {
    super(`illegal transition ${from} -> ${to} by ${cause_}`);
  }
}

/**
 * A destructive action would strand a flow parent (a live job still waits on what the action
 * deletes), so it was refused and nothing changed. The caller removes or finishes the parent first.
 */
export class FlowProtectedError extends QcloudError {
  readonly code = 'FLOW_PROTECTED';
  constructor(
    readonly target: string,
    reason: string
  ) {
    super(`${target} was not changed: ${reason}`);
  }
}

/**
 * A flow was refused before anything was written: its tree is too deep or too large, repeats a job id,
 * sets a policy where there is no parent, or reuses the id of a live job that is not its own root.
 */
export class FlowError extends QcloudError {
  readonly code = 'FLOW_INVALID';
}

/** The job exists but is in a state that does not allow the operation. Nothing was changed. */
export class JobStateError extends QcloudError {
  readonly code = 'JOB_STATE';
  constructor(
    readonly jobId: string,
    /** The job's state, or null when it does not exist. */
    readonly state: string | null,
    readonly operation: string
  ) {
    super(
      state === null
        ? `job ${jobId} not found, so it cannot be ${operation}`
        : `job ${jobId} is ${state}, so it cannot be ${operation}`
    );
  }
}

/**
 * An operator action named the `version` of the job it was decided against, and the job has moved on
 * (a worker claimed it, another operator changed it). Nothing was changed: read the job again.
 */
export class JobVersionError extends QcloudError {
  readonly code = 'JOB_VERSION';
  constructor(
    readonly jobId: string,
    readonly expected: number,
    readonly actual: number
  ) {
    super(`job ${jobId} is at version ${actual}, not the expected ${expected}`);
  }
}

/**
 * A workflow execution was written from a copy that is no longer the row's version: another engine
 * advanced, failed, parked or removed it. Nothing was changed. The writer stops; the engine that
 * won owns the run.
 */
export class ExecutionStaleError extends QcloudError {
  readonly code = 'EXECUTION_STALE';
  constructor(
    readonly executionId: string,
    readonly expected: number,
    /** The row's version now, or null when the execution is gone. */
    readonly actual: number | null
  ) {
    super(
      actual === null
        ? `execution ${executionId} no longer exists; the write was made at version ${expected}`
        : `execution ${executionId} is at version ${actual}, not the expected ${expected}`
    );
  }
}

/** `save` found an execution with that id. Nothing was changed. */
export class ExecutionExistsError extends QcloudError {
  readonly code = 'EXECUTION_EXISTS';
  constructor(readonly executionId: string) {
    super(`execution ${executionId} already exists`);
  }
}

/**
 * A signal was refused and nothing was recorded: the run is not live (`state`), or the same event
 * was already received (`duplicate`).
 */
export class SignalRejectedError extends QcloudError {
  readonly code = 'SIGNAL_REJECTED';
  constructor(
    readonly executionId: string,
    readonly event: string,
    readonly reason: 'state' | 'duplicate',
    /** For `state`: the run's state. */
    readonly state?: string
  ) {
    super(
      reason === 'duplicate'
        ? `Signal "${event}" was already received for execution "${executionId}"`
        : `Execution "${executionId}" is "${state}" and cannot receive the signal "${event}"`
    );
  }
}
