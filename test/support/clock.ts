import type { Clock } from '@qelay-cloud/core';

/** A clock that moves only when a test moves it. */
export class ManualClock implements Clock {
  #now: number;

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now += ms;
  }
}
