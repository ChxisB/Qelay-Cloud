import type { DeliveryTransport, TickBudget } from '@qelay-cloud/core';
import { UnsupportedOptionError } from '@qelay-cloud/core';

/** The in-process tick's interval, and the default of `TickOptions.intervalMs`. */
export const DEFAULT_TICK_INTERVAL_MS = 5_000;
/** How late a tick can start after its time (a timer, a busy event loop, a scheduler's jitter). */
export const DEFAULT_WORST_LATENESS_MS = 1_000;
export const DEFAULT_RING_GRACE_MS = 2_000;
export const DEFAULT_MAX_RINGS_PER_QUEUE = 100;
export const DEFAULT_MAX_ITEMS = 200;
export const DEFAULT_MAX_PASS_MS = 5_000;
export const DEFAULT_MAX_RUN_MS = 20_000;
/** The widest window a store takes: a year and a day, the SDK's ceiling for a transport with no limit. */
export const MAX_RING_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

export interface TickOptions {
  /**
   * The longest gap between two ticks this deployment promises: the in-process loop's interval, or
   * the period of the scheduler that calls the endpoint (60,000 for Cloud Scheduler's minute).
   * Default 5,000.
   */
  readonly intervalMs?: number;
  /**
   * A claimable job whose last bell is this old is rung again. At most `intervalMs`, because a lost
   * bell is found by the first tick after it turns this old: the bound on a lost bell is this plus
   * one interval. Default: `intervalMs`, the largest value allowed, which rings the fewest spare bells.
   */
  readonly reRingAfterMs?: number;
  /** A job created this recently with no bell yet is left alone: its publish may be in flight. Default 2,000. */
  readonly ringGraceMs?: number;
  /** How late a tick can start. Part of the window's floor. Default 1,000. */
  readonly worstLatenessMs?: number;
  /**
   * How far ahead a delayed job is rung. 0 rings it only once due. Otherwise at least
   * `intervalMs + worstLatenessMs`, and it is clamped to what the transport and the store can hold.
   * Default: that floor.
   */
  readonly ringWindowMs?: number;
  /** Most rings per queue in one pass, so a backlog does not become one bell per job on every tick. Default 100. */
  readonly maxRingsPerQueue?: number;
  /**
   * Most re-rings per queue in one pass, of jobs that already had a bell. Default: `maxRingsPerQueue`.
   * Lower it (1 to 10) once every consumer claims again while a queue has more, so a standing backlog
   * is not re-rung `maxRingsPerQueue` times per interval.
   */
  readonly maxStaleRingsPerQueue?: number;
  /** Most items per step of one pass. Default 200. */
  readonly maxItems?: number;
  /** Wall-clock budget of one pass. The steps after it are skipped. Default 5,000. */
  readonly maxPassMs?: number;
  /** Wall-clock budget of one invocation: passes repeat while there is more work. Default 20,000. */
  readonly maxRunMs?: number;
  /**
   * For a loop that beats often: the retention steps (DLQ, workers, webhook deliveries, events,
   * completions, metric buckets) run once per this many ms, and the beats in between do the rest.
   * 0 runs them on every beat, as a scheduler-called tick does. Default 0.
   */
  readonly upkeepEveryMs?: number;
}

/** A tick's settings after validation: what `runTick` and `runTicks` take. */
export interface TickConfig {
  readonly intervalMs: number;
  readonly maxRunMs: number;
  /** The window a delayed job is rung ahead by, after the clamps. 0: only once due. */
  readonly windowMs: number;
  /**
   * How late a delayed job can be because of the tick: 0 when the window holds a tick's gap and the
   * job is rung ahead of its time (its precision is then the broker's), otherwise the part of the
   * gap the window does not cover. `intervalMs` plus the worst lateness when the window is 0.
   */
  readonly delayPrecisionMs: number;
  readonly upkeepEveryMs: number;
  readonly budget: TickBudget;
}

function integer(name: string, value: number | undefined, fallback: number, min: number): number {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < min) {
    throw new UnsupportedOptionError(
      name,
      min === 0 ? 'must be a non-negative integer' : 'must be a positive integer'
    );
  }
  return chosen;
}

/** How far ahead the transport can hold a bell, as a finite number. */
export function transportWindowMs(transport: Pick<DeliveryTransport, 'capabilities'>): number {
  const max = transport.capabilities.maxDeliverDelayMs;
  return Number.isFinite(max) ? Math.max(0, Math.floor(max)) : MAX_RING_WINDOW_MS;
}

/**
 * Validates the options and works out the window. Throws `UnsupportedOptionError` for what no tick
 * could run with, above all a `reRingAfterMs` longer than the interval, which would stretch the
 * bound on a lost bell past the documented one. `store` is given when the window of the store the
 * tick runs on is known: the store clamps to it, so the window reported here is the effective one.
 */
export function resolveTickConfig(
  transport: Pick<DeliveryTransport, 'capabilities'>,
  options: TickOptions = {},
  store: { readonly ringWindowMs: number } = { ringWindowMs: MAX_RING_WINDOW_MS }
): TickConfig {
  const intervalMs = integer('intervalMs', options.intervalMs, DEFAULT_TICK_INTERVAL_MS, 1);
  const reRingAfterMs = integer('reRingAfterMs', options.reRingAfterMs, intervalMs, 0);
  if (reRingAfterMs > intervalMs) {
    throw new UnsupportedOptionError(
      'reRingAfterMs',
      `is ${reRingAfterMs} but the tick interval is ${intervalMs}: a bell lost just after a tick would be found only ${reRingAfterMs + intervalMs} ms later; give a value of at most ${intervalMs}`
    );
  }
  const worstLatenessMs = integer(
    'worstLatenessMs',
    options.worstLatenessMs,
    DEFAULT_WORST_LATENESS_MS,
    0
  );
  const floor = intervalMs + worstLatenessMs;
  const ceiling = Math.min(transportWindowMs(transport), Math.max(0, store.ringWindowMs));
  const asked = integer('ringWindowMs', options.ringWindowMs, floor, 0);
  if (asked !== 0 && asked < floor) {
    throw new UnsupportedOptionError(
      'ringWindowMs',
      `is ${asked}, below the interval plus the worst lateness (${floor}): a job due between two ticks would be rung late; give 0 to ring delayed jobs only once due, or at least ${floor}`
    );
  }
  const windowMs = Math.min(asked, ceiling);
  const budget: TickBudget = {
    maxDurationMs: integer('maxPassMs', options.maxPassMs, DEFAULT_MAX_PASS_MS, 0),
    maxRingsPerQueue: integer(
      'maxRingsPerQueue',
      options.maxRingsPerQueue,
      DEFAULT_MAX_RINGS_PER_QUEUE,
      1
    ),
    ...(options.maxStaleRingsPerQueue === undefined
      ? {}
      : {
          maxStaleRingsPerQueue: integer(
            'maxStaleRingsPerQueue',
            options.maxStaleRingsPerQueue,
            DEFAULT_MAX_RINGS_PER_QUEUE,
            1
          ),
        }),
    maxItems: integer('maxItems', options.maxItems, DEFAULT_MAX_ITEMS, 1),
    reRingAfterMs,
    ringGraceMs: integer('ringGraceMs', options.ringGraceMs, DEFAULT_RING_GRACE_MS, 0),
    ringWindowMs: windowMs,
  };
  return {
    intervalMs,
    maxRunMs: integer('maxRunMs', options.maxRunMs, DEFAULT_MAX_RUN_MS, 0),
    windowMs,
    delayPrecisionMs: Math.max(0, floor - windowMs),
    upkeepEveryMs: integer('upkeepEveryMs', options.upkeepEveryMs, 0, 0),
    budget,
  };
}
