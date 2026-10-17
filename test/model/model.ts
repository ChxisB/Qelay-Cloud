import {
  IllegalTransitionError,
  assertTransition as assertCoreTransition,
} from '@qelay-cloud/core';
import type { Cause, TransitionTarget } from '@qelay-cloud/core';
import type { JobState } from './store';

/**
 * Reference model rules, written from Qelay's documented semantics (`docs/data-model.md`
 * upstream), not from any store's code. The transition table lives in `@qelay-cloud/core`.
 */

/** Where a job is in its life. `pending` covers waiting, prioritized and delayed. */
export type Phase = 'pending' | 'active' | 'completed' | 'failed';

export interface ModelJob {
  readonly id: string;
  readonly queue: string;
  /** Generation of a custom id; 1 for generated ids. Stored in the job's data. */
  readonly generation: number;
  /** Creation order. Generated ids must sort the same way (UUIDv7 does). */
  readonly seq: number;
  readonly custom: boolean;
  readonly lifo: boolean;
  readonly maxAttempts: number;
  priority: number;
  runAt: number;
  attempts: number;
  phase: Phase;
  leaseNo: number | null;
  leaseOwner: string | null;
  leaseUntil: number;
}

/** A lease the harness was handed by a claim. `no` maps to the store's token. */
export interface ModelLease {
  readonly no: number;
  readonly jobId: string;
  readonly generation: number;
  readonly worker: string;
}

/** The state `getJob` must report. A delayed job is ready once `runAt <= now`, with no tick. */
export function stateOf(job: ModelJob, now: number): JobState {
  if (job.phase !== 'pending') return job.phase;
  if (job.runAt > now) return 'delayed';
  return job.priority > 0 ? 'prioritized' : 'waiting';
}

export function isTerminal(state: JobState): boolean {
  return state === 'completed' || state === 'failed';
}

export type { Cause, TransitionTarget } from '@qelay-cloud/core';
export { TRANSITIONS, allows, isLegalMove } from '@qelay-cloud/core';

/** A transition the model itself tried to make that the table forbids: a harness bug. */
export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelError';
  }
}

export function assertTransition(cause: Cause, from: JobState, to: TransitionTarget): void {
  try {
    assertCoreTransition(cause, from, to);
  } catch (error) {
    if (error instanceof IllegalTransitionError) throw new ModelError(error.message);
    throw error;
  }
}

/**
 * Claim order: higher priority first; at equal priority LIFO jobs before FIFO jobs; LIFO jobs
 * newest first; FIFO jobs by `runAt`, then oldest first. Returns 0 for a FIFO tie at equal
 * `runAt` that involves a custom id, which a store may break either way (it sorts by id).
 */
export function compareClaimOrder(a: ModelJob, b: ModelJob): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.lifo !== b.lifo) return a.lifo ? -1 : 1;
  if (a.lifo) return b.seq - a.seq;
  if (a.runAt !== b.runAt) return a.runAt - b.runAt;
  if (a.custom || b.custom) return 0;
  return a.seq - b.seq;
}

export type OrderRule = 'ORDER.priority' | 'ORDER.lifo' | 'ORDER.fifo';

/** The rule broken when `skipped` should have been claimed before `taken`. */
export function brokenOrderRule(skipped: ModelJob, taken: ModelJob): OrderRule {
  if (skipped.priority !== taken.priority) return 'ORDER.priority';
  return skipped.lifo || taken.lifo ? 'ORDER.lifo' : 'ORDER.fifo';
}
