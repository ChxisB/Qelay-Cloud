/** Source of time in epoch milliseconds. The store reads it, never `Date.now()`, so tests can drive time. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Source of randomness for backoff jitter. Injectable so model runs replay. */
export interface Random {
  /** A float in [0, 1). */
  next(): number;
}

export const systemRandom: Random = { next: () => Math.random() };

/** Generates job ids. The default store generator is UUIDv7, so ids sort in creation order. */
export interface IdGenerator {
  next(): string;
}
