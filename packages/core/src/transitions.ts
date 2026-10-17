import { IllegalTransitionError } from './errors';
import type { JobState } from './jobs';

/**
 * The job state machine as data. Moved from the task 02 harness (`test/model/model.ts`); the
 * harness and the store both read this table, so they cannot drift apart.
 */

export type Cause =
  | 'due'
  | 'claim'
  | 'complete'
  | 'fail-retry'
  | 'fail-dlq'
  | 'recover-retry'
  | 'recover-dlq'
  | 'promote'
  | 'change-priority'
  | 'cancel'
  | 'retire'
  | 'unmet-dependency'
  | 'dependencies-done'
  | 'move-to-wait'
  | 'release'
  | 'move-to-waiting-children'
  | 'discard'
  | 'retry-dlq'
  | 'change-delay';

/** `removed` means the row is gone. */
export type TransitionTarget = JobState | 'removed';

export interface Transition {
  readonly cause: Cause;
  readonly from: readonly JobState[];
  readonly to: readonly TransitionTarget[];
}

const PENDING: readonly JobState[] = ['waiting', 'prioritized', 'delayed'];
const READY: readonly JobState[] = ['waiting', 'prioritized'];

export const TRANSITIONS: readonly Transition[] = [
  { cause: 'due', from: ['delayed'], to: READY },
  { cause: 'claim', from: READY, to: ['active'] },
  { cause: 'complete', from: ['active'], to: ['completed'] },
  { cause: 'fail-retry', from: ['active'], to: PENDING },
  { cause: 'fail-dlq', from: ['active'], to: ['failed'] },
  { cause: 'recover-retry', from: ['active'], to: PENDING },
  { cause: 'recover-dlq', from: ['active'], to: ['failed'] },
  { cause: 'promote', from: ['delayed'], to: READY },
  { cause: 'change-priority', from: PENDING, to: PENDING },
  { cause: 'cancel', from: [...PENDING, 'waiting-children'], to: ['removed'] },
  { cause: 'retire', from: ['completed', 'failed'], to: ['removed'] },
  { cause: 'unmet-dependency', from: ['waiting'], to: ['waiting-children'] },
  { cause: 'dependencies-done', from: ['waiting-children'], to: READY },
  { cause: 'move-to-wait', from: ['active'], to: READY },
  { cause: 'release', from: ['active'], to: READY },
  { cause: 'move-to-waiting-children', from: ['active'], to: ['waiting-children'] },
  { cause: 'discard', from: [...PENDING, 'active'], to: ['failed'] },
  { cause: 'retry-dlq', from: ['failed'], to: READY },
  { cause: 'change-delay', from: [...PENDING, 'active'], to: ['delayed'] },
];

/** Whether `cause` may act on a job in `state`. Operation guards come from here. */
export function allows(cause: Cause, state: JobState): boolean {
  return TRANSITIONS.some((t) => t.cause === cause && t.from.includes(state));
}

/** Whether any cause moves a job from `from` to `to`. Staying in the same state is not a move. */
export function isLegalMove(from: JobState, to: TransitionTarget): boolean {
  if (from === to) return true;
  return TRANSITIONS.some((t) => t.from.includes(from) && t.to.includes(to));
}

/** Throws `IllegalTransitionError` unless `cause` may take a job from `from` to `to`. */
export function assertTransition(cause: Cause, from: JobState, to: TransitionTarget): void {
  const ok = TRANSITIONS.some(
    (t) => t.cause === cause && t.from.includes(from) && t.to.includes(to)
  );
  if (!ok) throw new IllegalTransitionError(cause, from, to);
}

/** Whether a job in `state` can be claimed now (given its `runAt` has passed). */
export function isClaimable(state: JobState): boolean {
  return allows('claim', state);
}

export function isTerminal(state: JobState): boolean {
  return state === 'completed' || state === 'failed';
}
