/**
 * The engine's source of time and randomness, injected per engine.
 *
 * Upstream routed every `Date.now()`, `Math.random()` and `setTimeout` through one process-global
 * clock so a simulation could replay a seed exactly. Here the clock is an option of the `Engine`
 * and travels in the step hooks, so two engines in one process (a worker that "crashes" and the
 * one that takes over) can share a simulated clock without a global to restore.
 *
 * Durable deadlines (a `waitFor` timeout) do not come from here: the store's clock decides them
 * (`WorkflowStorePort.now`), so every worker agrees on when a wait is due.
 */

export interface TimerHandle {
  /** Real timers can be unref'd so a pending one does not hold the process open. */
  unref?(): void;
}

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Schedule `fn` after `ms`. The handle is whatever `clearTimeout` accepts. */
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  /** A number in [0, 1). Used for retry jitter. */
  random(): number;
  /** Replayable entropy; cryptographically strong on the real clock. */
  randomBytes(length: number): Uint8Array;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as TimerHandle,
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
  randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
};
