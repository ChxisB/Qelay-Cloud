import type { JobState, Ring } from '@qelay-cloud/core';

/** States that hold a dedup key and a custom id: the ones the live unique index covers. */
const LIVE: ReadonlySet<string> = new Set([
  'waiting',
  'prioritized',
  'delayed',
  'waiting-children',
  'active',
]);
const PENDING: ReadonlySet<string> = new Set(['waiting', 'prioritized', 'delayed']);

export const isLiveState = (state: string): boolean => LIVE.has(state);
/** Waiting to be claimed (now or later): what a group's `maxSize` counts. */
export const isPendingState = (state: string): boolean => PENDING.has(state);

/** The state a new job starts in. */
export function initialState(runAt: number, now: number, priority: number) {
  if (runAt > now) return 'delayed' as const;
  return priority > 0 ? ('prioritized' as const) : ('waiting' as const);
}

/**
 * The state a reader reports. Promotion of a due delayed job is the tick's work (task 15), so a
 * stored `delayed` row can be past its `run_at`; it is claimable then, and every reader says so.
 */
export function effectiveState(
  stored: string,
  runAt: number,
  priority: number,
  now: number
): JobState {
  return PENDING.has(stored) ? initialState(runAt, now, priority) : (stored as JobState);
}

/**
 * The ring for a job that was just made pending, or null when none is due yet. A claimable job is
 * rung now. A delayed job is rung once its delay fits the transport's window (`ringWindowMs`: 0
 * when the transport cannot delay delivery), and otherwise the tick rings it nearer its time.
 */
export function ringFor(
  namespace: string,
  queue: string,
  jobId: string,
  runAt: number,
  now: number,
  ringWindowMs: number
): Ring | null {
  const dueInMs = Math.max(0, runAt - now);
  if (dueInMs > ringWindowMs) return null;
  return { bell: { namespace, queue, jobId }, dueInMs };
}
