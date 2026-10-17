/** The queue, the four kinds of job, and the one processor that handles them. */
import type { JobOptions } from '../../../packages/core/src';
import type { WorkerJob } from '../../../packages/sdk/src';

export const QUEUE = 'orders';

export const JOBS = {
  /** An ordinary job: runs once, now. */
  placed: 'order-placed',
  /** A delayed job: runs once, some time from now. */
  reminder: 'payment-reminder',
  /** A recurring job: created by the tick from a cron entry, never by the producer. */
  report: 'daily-report',
  /** A job that always fails: three tries with a short backoff, then it lands in the dead-letter queue. */
  charge: 'charge-card',
} as const;

export const CHARGE_OPTIONS: JobOptions = {
  attempts: 3,
  backoff: { type: 'fixed', delay: 500 },
};

export interface Order {
  readonly orderId: number;
  readonly cents: number;
}

/** Where the example keeps what it did, so the demo and the test can check it. */
export type Ledger = Map<string, number>;

export function ordersProcessor(ledger: Ledger) {
  return async (job: WorkerJob<Order>): Promise<string> => {
    ledger.set(job.name, (ledger.get(job.name) ?? 0) + 1);
    if (job.name === JOBS.charge) {
      // A card that is never accepted: the retries and the dead-letter queue are the point.
      throw new Error(`card declined for order ${job.data.orderId}`);
    }
    return `${job.name} done`;
  };
}
