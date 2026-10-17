/**
 * The rules every workflow store shares, so the in-memory reference and the Postgres store cannot
 * disagree on them. Ported from `../qelay/src/client/workflow/{admission,storeSignals,storeListing,
 * storeMaintenance}.ts` (see docs/PORTING.md).
 */
import type { Execution, ExecutionListOptions, ExecutionState } from './workflowTypes';
import {
  DEFAULT_LIST_LIMIT,
  EXECUTION_STATES,
  MAX_LIST_LIMIT,
  type RollbackStatus,
} from './workflowTypes';

/** States in which a node job may execute. Anything else is not a live run. */
export function isLive(state: ExecutionState): boolean {
  return state === 'running' || state === 'waiting';
}

/** States whose definition must stay available: `listActive`. */
export const ACTIVE_STATES: readonly ExecutionState[] = [
  'running',
  'waiting',
  'compensating',
  'compensation-stuck',
  'failed',
];

/** States recovery may drive. Not `compensation-stuck`: it waits for an operator. */
export const RECOVERABLE_STATES: readonly ExecutionState[] = [
  'running',
  'waiting',
  'compensating',
  'failed',
];

/** The states a recovery sweep asked for, refusing one that recovery never drives. */
export function recoverableStates(asked: readonly ExecutionState[] | undefined): ExecutionState[] {
  if (asked === undefined) return [...RECOVERABLE_STATES];
  for (const state of asked) {
    if (!RECOVERABLE_STATES.includes(state)) {
      throw new TypeError(`Recovery does not drive the state "${state}"`);
    }
  }
  return [...new Set(asked)];
}

/** A failed run whose rollback has a recorded outcome is finished, not active. */
export function isActive(exec: {
  state: ExecutionState;
  rollbackStatus?: RollbackStatus;
}): boolean {
  return exec.state !== 'failed' || exec.rollbackStatus === undefined;
}

/**
 * Has this signal arrived? A KEY test, deliberately not a value test: `payload` is optional, so a
 * signal with nothing to carry is recorded as `signals[event] = undefined` and the key is the only
 * evidence. And `Object.hasOwn`, not `in`: `signals` is a plain object used as a map, so `in` walks
 * the prototype chain and a gate named `toString`, `constructor` or `valueOf` would open the moment
 * it parked, with nobody having signalled anything.
 */
export function hasSignal(signals: Record<string, unknown>, event: string): boolean {
  return Object.hasOwn(signals, event);
}

/**
 * Records `signals[event] = payload` as an own property. Plain assignment of the event `__proto__`
 * sets the prototype instead and leaves no key behind, so the signal would be accepted, the resume
 * claimed, and the gate would find no signal and park again for good.
 */
export function setSignal(signals: Record<string, unknown>, event: string, payload: unknown): void {
  Object.defineProperty(signals, event, {
    value: payload,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** An integer from 1 to `max`; the default when `value` is undefined. Anything else is a `RangeError`. */
export function boundedCount(
  what: string,
  value: number | undefined,
  fallback: number,
  max: number
): number {
  const count = value ?? fallback;
  if (!Number.isSafeInteger(count) || count < 1 || count > max) {
    throw new RangeError(`${what} must be an integer from 1 to ${max}`);
  }
  return count;
}

export function pageBounds(options: ExecutionListOptions): { limit: number; offset: number } {
  const limit = boundedCount(
    'Workflow execution list limit',
    options.limit,
    DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT
  );
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError('Workflow execution list offset must be a non-negative integer');
  }
  return { limit, offset };
}

/** The age a retention call cuts at: a finite number of milliseconds, not negative. */
export function retentionAge(maxAgeMs: number): number {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new RangeError(
      'Workflow retention age must be a finite, non-negative number of milliseconds'
    );
  }
  return maxAgeMs;
}

/** The states a retention call names, each one a real state. */
export function retentionStates(states: readonly string[]): ExecutionState[] {
  for (const state of states) {
    if (!EXECUTION_STATES.includes(state as ExecutionState)) {
      throw new RangeError(`"${state}" is not a workflow execution state`);
    }
  }
  return [...new Set(states)] as ExecutionState[];
}

/** `save` takes a new execution only: one that already carries signals would overwrite delivered ones. */
export function assertNewExecution(exec: Execution): void {
  if (Object.keys(exec.signals).length > 0) {
    throw new Error(
      'WorkflowStore.save() is for new executions only; it would overwrite delivered signals. Use update().'
    );
  }
}

/** A wait deadline: an integer epoch ms, or null for a wait with no timeout. */
export function waitDeadline(deadlineAt: number | undefined): number | null {
  if (deadlineAt === undefined) return null;
  if (!Number.isSafeInteger(deadlineAt)) {
    throw new RangeError('A wait deadline must be an integer number of epoch milliseconds');
  }
  return deadlineAt;
}
