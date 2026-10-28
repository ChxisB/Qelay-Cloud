import { UnsupportedOptionError } from './errors';
import type { BackoffOptions } from './jobs';
import { validateJobOptions } from './options';

/**
 * What a queue gives a job that sets none of its own (DESIGN.md D17). Each setting is applied at enqueue and only to a
 * job that left that setting out, so a job's own option always wins. Bounds are those of the job options.
 *
 * Retry jitter is not here: it is one switch for the whole service (the store's `jitter` option), not a setting of a
 * queue.
 */
export interface QueuePolicy {
  readonly attempts?: number;
  readonly backoff?: BackoffOptions;
  readonly timeout?: number;
}

const KEYS = ['attempts', 'backoff', 'timeout'];
const BACKOFF_KEYS = ['type', 'delay', 'maxDelay'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks a policy with the rules of the job options and returns it with the backoff written as an object. A setting that
 * is `undefined` is left out, so `{}` is a valid policy and means none. Throws `UnsupportedOptionError` naming the field.
 */
export function validateQueuePolicy(policy: unknown): QueuePolicy {
  if (!isRecord(policy)) throw new UnsupportedOptionError('policy', 'must be an object');
  for (const key of Object.keys(policy)) {
    if (policy[key] !== undefined && !KEYS.includes(key)) {
      throw new UnsupportedOptionError(key, 'is not a setting of a queue policy');
    }
  }
  const { attempts, backoff, timeout } = policy;
  if (isRecord(backoff)) {
    for (const key of Object.keys(backoff)) {
      if (backoff[key] !== undefined && !BACKOFF_KEYS.includes(key)) {
        throw new UnsupportedOptionError(
          `backoff.${key}`,
          key === 'jitter'
            ? 'is not a setting of a queue: jitter is one switch for the whole service'
            : 'is not a setting of a backoff'
        );
      }
    }
  }
  const options = validateJobOptions({
    ...(attempts !== undefined && { attempts: attempts as number }),
    ...(backoff !== undefined && { backoff: backoff as BackoffOptions }),
    ...(timeout !== undefined && { timeout: timeout as number }),
  });
  return {
    ...(options.attempts !== undefined && { attempts: options.attempts }),
    ...(options.backoff !== undefined && { backoff: backoffObject(options.backoff) }),
    ...(options.timeout !== undefined && { timeout: options.timeout }),
  };
}

function backoffObject(backoff: number | BackoffOptions): BackoffOptions {
  if (typeof backoff === 'number') return { type: 'fixed', delay: backoff };
  return backoff.maxDelay === undefined
    ? { type: backoff.type, delay: backoff.delay }
    : { type: backoff.type, delay: backoff.delay, maxDelay: backoff.maxDelay };
}
