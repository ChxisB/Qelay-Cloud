import type { Clock, DeliveryTransport } from '@qelay-cloud/core';
import type { PostgresStore } from '@qelay-cloud/store-postgres';
import { Queue } from 'qelay-cloud';
import type { TtlCache } from '../cache';
import { ApiError } from '../errors';
import type { Logger } from '../http/log';
import type { JobsConfig } from './limits';

/** What the jobs and queues routes share. One context is one store, which is one namespace. */
export interface JobsContext {
  readonly store: PostgresStore;
  readonly transport: DeliveryTransport;
  readonly config: JobsConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly cache: TtlCache;
  /** The SDK producer of a queue: what `POST /queues/:queue/jobs` adds through. */
  producer(queue: string): Queue;
}

const MAX_PRODUCERS = 1_000;

/**
 * Producers are built on first use and kept: a `Queue` opens nothing and holds no connection (it
 * uses the store it is given and never closes it), so the only cost of one is the object. Queue
 * names come from callers, so the set is bounded and is emptied when it fills.
 */
export function producerFor(
  store: PostgresStore,
  transport: DeliveryTransport,
  logger: Logger
): (queue: string) => Queue {
  const producers = new Map<string, Queue>();
  return (queue) => {
    let producer = producers.get(queue);
    if (producer === undefined) {
      if (producers.size >= MAX_PRODUCERS) producers.clear();
      producer = new Queue(queue, {
        store,
        transport,
        logger: { warn: (message, context) => logger.warn(message, context) },
      });
      producers.set(queue, producer);
    }
    return producer;
  };
}

/** 404 `job_not_found`: the answer for an id this namespace has no job under. */
export const jobNotFound = (id: string): ApiError =>
  new ApiError(404, 'job_not_found', 'job not found', { jobId: id });

/**
 * Why an action that answered "no change" did not apply: the job does not exist (404) or is in a
 * state the action does not take (409). The state is read after the refusal, so under a race it
 * can be newer than the one the refusal saw; it is advice for the caller and nothing relies on it.
 */
export async function explainRefusal(ctx: JobsContext, id: string): Promise<never> {
  const job = await ctx.store.getJob(id);
  if (job === null) throw jobNotFound(id);
  throw new ApiError(409, 'job_state', `the job is ${job.state}, so the action does not apply`, {
    jobId: id,
    state: job.state,
  });
}
