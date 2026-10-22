import { StoreError } from '@qelay-cloud/core';

/** The database holds a schema version this code cannot run against. Nothing was changed. */
export class SchemaVersionError extends StoreError {
  constructor(
    message: string,
    readonly databaseVersion: number | null,
    readonly codeVersion: number
  ) {
    super(message);
  }
}

/**
 * The database does not match what the recorded migrations say it should hold: a migration edited
 * after it was applied, or an object that has gone missing. Nothing was changed. Fix the database
 * or add a new migration; never edit an applied one.
 */
export class SchemaDriftError extends StoreError {}

/** A migration statement failed. The whole migration was rolled back. */
export class MigrationError extends StoreError {
  constructor(
    message: string,
    readonly version: number,
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}

/** Connection options that are contradictory or unsafe. Raised before any socket is opened. */
export class ConnectionConfigError extends StoreError {}

/** A fleet that needs more connections than the database allows. The message carries the budget. */
export class ConnectionBudgetError extends StoreError {}

/** An enqueue call with more jobs than one transaction admits. Nothing was admitted. */
export class BatchTooLargeError extends StoreError {
  constructor(
    readonly size: number,
    readonly limit: number
  ) {
    super(`enqueue takes at most ${limit} jobs per call, got ${size}. Nothing was admitted.`);
  }
}

/**
 * A workflow execution column (`input`, `steps`, `signals`, ...) that encodes to more than the store
 * keeps in one. Nothing was written: the run stays as it was.
 */
export class ExecutionTooLargeError extends StoreError {
  constructor(
    readonly executionId: string,
    readonly column: string,
    readonly size: number,
    readonly limit: number
  ) {
    super(
      `workflow execution "${executionId}" has a ${column} of ${size} bytes, over the limit of ${limit}. Nothing was written.`
    );
  }
}

/**
 * A payload with more values than the store decodes safely, or nested deeper than it allows (`kind`).
 * `index` is the job's position in the call. Nothing was admitted.
 */
export class PayloadTooComplexError extends StoreError {
  constructor(
    readonly kind: 'nodes' | 'depth',
    readonly limit: number,
    readonly index: number
  ) {
    super(
      `job ${index} has a payload ${kind === 'nodes' ? `of more than ${limit} values` : `nested deeper than ${limit}`}. Nothing was admitted.`
    );
  }
}

/** An encoded payload over the size limit. `index` is the job's position in the call. Nothing was admitted. */
export class PayloadTooLargeError extends StoreError {
  constructor(
    readonly size: number,
    readonly limit: number,
    readonly index: number
  ) {
    super(
      `job ${index} has a payload of ${size} bytes, over the limit of ${limit}. Nothing was admitted.`
    );
  }
}

/** A job's group already holds `maxSize` pending jobs. The whole enqueue call was rolled back. */
export class GroupFullError extends StoreError {
  constructor(
    readonly queue: string,
    readonly groupId: string,
    readonly maxSize: number,
    readonly index: number
  ) {
    super(
      `group ${groupId} of queue ${queue} has reached its maximum size of ${maxSize} ` +
        `(job ${index}). Nothing was admitted.`
    );
  }
}

/** A `StateStore` method whose task has not landed yet. A typed failure, never a silent no-op. */
export class NotImplementedError extends StoreError {
  constructor(
    readonly method: string,
    readonly task: number
  ) {
    super(`${method} is not implemented yet (task ${task})`);
  }
}

/** The namespace already holds the most webhooks it may. Nothing was created. */
export class WebhookLimitError extends StoreError {
  constructor(readonly limit: number) {
    super(`a namespace can register at most ${limit} webhooks`);
  }
}

/** A webhook secret was given and the store has no `webhookKey` to seal it with. Nothing was created. */
export class WebhookKeyError extends StoreError {}

/** A route would make queues feed each other in a loop. Nothing was saved. */
export class RouteCycleError extends StoreError {
  constructor() {
    super('the route would make a loop: a queue would end up adding jobs to itself');
  }
}

/** A route would make a chain of routes longer than `MAX_ROUTE_CHAIN`. Nothing was saved. */
export class RouteChainError extends StoreError {
  constructor(readonly limit: number) {
    super(`a chain of routes can be at most ${limit} routes long`);
  }
}

/** A test delivery was asked of a webhook that is disabled: nothing sends for a disabled webhook. */
export class WebhookDisabledError extends StoreError {}

/** The namespace already keeps the most saved destinations it may. Nothing was created. */
export class DestinationLimitError extends StoreError {
  constructor(readonly limit: number) {
    super(`a namespace can keep at most ${limit} destinations`);
  }
}

/** Another destination of the namespace already has this name. Nothing was saved. */
export class DestinationNameTakenError extends StoreError {
  constructor(readonly name: string) {
    super(`a destination named "${name}" already exists`);
  }
}

/** A destination is still used by webhooks, so it was not removed. */
export class DestinationInUseError extends StoreError {
  constructor(readonly connections: number) {
    super(`the destination is used by ${connections} webhook${connections === 1 ? '' : 's'}`);
  }
}
