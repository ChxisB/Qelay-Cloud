import type { ClaimedJob, ClaimOptions } from '@qelay-cloud/core';
import { MAX_CLAIM } from '@qelay-cloud/store-postgres';
import { asError } from './errorText';
import type { Runtime } from './runtime';
import { claimForBell } from './workerClaim';

export interface PumpConfig {
  readonly rt: Runtime;
  readonly queue: string;
  readonly owner: string;
  readonly options: ClaimOptions;
  /** Free slots, net of the ones `Pump` holds for a claim in flight. */
  readonly capacity: () => number;
  readonly closing: () => boolean;
  readonly start: (job: ClaimedJob, startedAt: number) => void;
  readonly emitError: (error: Error) => void;
}

/**
 * The worker's claims. A bell starts one (`claimAndStart`), and a claim that came back full says the
 * queue likely has more, so after a job ends `pump` claims again for the free slots without waiting
 * for a bell, until a claim comes back short. A busy queue then needs a bell to wake an idle worker,
 * not one per job. Slots are held from before the first await, so a bell and the pump never take the
 * same ones.
 */
export class Pump {
  readonly #config: PumpConfig;
  #reserved = 0;
  #backlog = false;
  #pumping = false;

  constructor(config: PumpConfig) {
    this.#config = config;
  }

  /** Slots held for claims in flight. */
  get reserved(): number {
    return this.#reserved;
  }

  /** How many jobs a claim may ask for now. */
  want(): number {
    return Math.min(this.#config.capacity(), MAX_CLAIM);
  }

  /** Claims `want` jobs and starts them: how many, or null when the claim failed (counted and emitted). */
  async claimAndStart(want: number): Promise<number | null> {
    const { rt, queue, owner, options, closing, start, emitError } = this.#config;
    this.#reserved += want;
    const startedAt = performance.now();
    let claimed: ClaimedJob[];
    try {
      claimed = await claimForBell(rt, { queue, owner, want, options, closing });
    } catch (error) {
      rt.count('qcloud.worker.claim_failed');
      emitError(asError(error));
      return null;
    } finally {
      this.#reserved -= want;
    }
    this.#backlog = claimed.length === want;
    if (closing()) {
      // The claim landed after `close` began: give the jobs back instead of starting them.
      await Promise.all(claimed.map((job) => rt.store.release(job.lease).catch(() => {})));
      return claimed.length;
    }
    for (const job of claimed) start(job, startedAt);
    return claimed.length;
  }

  /** Claims again while the last claim came back full and a slot is free. One pump runs at a time. */
  async pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (let want = this.want(); this.#backlog && want > 0; want = this.want()) {
        if ((await this.claimAndStart(want)) === null) this.#backlog = false;
      }
    } finally {
      this.#pumping = false;
    }
  }
}
