import type { Lease, Outcome } from '@qelay-cloud/core';
import type { PostgresStore } from '@qelay-cloud/store-postgres';

interface Pending {
  readonly lease: Lease;
  readonly result: unknown;
  readonly resolve: (outcome: Outcome) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Completes that arrive while another complete is being stored share one `completeMany`
 * transaction. As in `AddBatcher`, nothing waits on a timer: the first complete of an idle worker goes out
 * in the same tick, so a worker that finishes one job at a time sees no change. Each caller gets its own
 * outcome; a result the store refuses fails that job alone, and any other failure rejects the whole
 * batch, which each job's settle then retries once, as it would a single write.
 */
export class CompleteBatcher {
  readonly #store: PostgresStore;
  readonly #maxJobs: number;
  readonly #observe: (size: number) => void;
  #pending: Pending[] = [];
  #running: Promise<void> | null = null;

  constructor(store: PostgresStore, maxJobs: number, observe: (size: number) => void) {
    this.#store = store;
    this.#maxJobs = maxJobs;
    this.#observe = observe;
  }

  complete(lease: Lease, result: unknown): Promise<Outcome> {
    return new Promise((resolve, reject) => {
      this.#pending.push({ lease, result, resolve, reject });
      if (this.#running === null) this.#running = Promise.resolve().then(() => this.#run());
    });
  }

  async #run(): Promise<void> {
    try {
      while (this.#pending.length > 0) await this.#flush(this.#pending.splice(0, this.#maxJobs));
    } finally {
      // No await since the loop test, so a complete made after it cannot see a stale `#running`.
      this.#running = null;
    }
  }

  async #flush(batch: Pending[]): Promise<void> {
    this.#observe(batch.length);
    try {
      const outcomes = await this.#store.completeMany(
        batch.map(({ lease, result }) => ({ lease, result }))
      );
      batch.forEach((pending, index) => {
        const outcome = outcomes[index]!;
        if (outcome instanceof Error) pending.reject(outcome);
        else pending.resolve(outcome);
      });
    } catch (error) {
      for (const pending of batch) pending.reject(error);
    }
  }
}
