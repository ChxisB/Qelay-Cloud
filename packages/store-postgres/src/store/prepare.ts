import type { BackoffOptions, Codec, JobOptions, NewJob } from '@qelay-cloud/core';
import { StoreError, UnsupportedOptionError, validateJobOptions } from '@qelay-cloud/core';
import { BatchTooLargeError, PayloadTooComplexError, PayloadTooLargeError } from '../errors';
import type { ShapeLimits } from './payloadShape';
import { overShape } from './payloadShape';

/** Most jobs one `enqueue` call admits. The bulk insert runs in chunks of this size. */
export const MAX_BATCH = 1000;
/** Largest encoded payload (`name`, `data` and retry settings together) of one job. */
export const MAX_PAYLOAD_BYTES = 1024 * 1024;
/** Longest queue name, job name, custom job id, dedup key and group id, in characters (upstream's job-name limit; the others are indexed). */
export const MAX_IDENTIFIER_CHARS = 256;
/** Upstream's default retry delay when the job has no `backoff` (`JOB_DEFAULTS.backoff`). */
export const DEFAULT_BACKOFF_MS = 1000;

/** The name of a job whose caller gives none. */
export const DEFAULT_JOB_NAME = 'default';
// A lone surrogate cannot be stored in a UTF-8 column.
export const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MIN_INTEGER = -2_147_483_648;
const MAX_INTEGER = 2_147_483_647;

/**
 * What a job's `payload` column holds: everything about the job that no query filters on. The
 * columns carry what queries do filter on (priority, run time, attempts, keys, group).
 */
export interface Envelope {
  readonly v: 1;
  readonly name: string;
  readonly data: unknown;
  readonly backoff: Required<Pick<BackoffOptions, 'type' | 'delay'>> & { maxDelay?: number };
  readonly stallTimeout?: number;
  readonly dedup?: { readonly ttl?: number; readonly extend?: boolean; readonly replace?: boolean };
  readonly groupMaxSize?: number;
  readonly removeOnComplete?: boolean;
  readonly removeOnFail?: boolean;
  /** `NewJob.trace`. Absent for a job added without tracing, and for every job an older release wrote. */
  readonly trace?: string;
}

/** One enqueue request, validated and encoded, ready for the transaction. */
export interface PreparedJob {
  /** Position in the caller's array. */
  readonly index: number;
  /** The custom id, which is the job's id. Null: the store generates a UUIDv7. */
  readonly customId: string | null;
  readonly queue: string;
  readonly payload: Uint8Array;
  readonly priority: number;
  readonly lifo: boolean;
  readonly delayMs: number;
  readonly maxAttempts: number;
  readonly timeout: number | null;
  readonly dedupKey: string | null;
  readonly dedupTtl: number | null;
  readonly dedupExtend: boolean;
  readonly dedupReplace: boolean;
  readonly groupId: string | null;
  readonly groupMaxSize: number | null;
  /** What `payload` was encoded from, kept so a queue policy can change the backoff and encode it again. */
  readonly envelope: Envelope;
  /** Which of the three settings the job set itself: a queue policy only fills the others (DESIGN.md D17). */
  readonly own: {
    readonly attempts: boolean;
    readonly backoff: boolean;
    readonly timeout: boolean;
  };
}

export interface PrepareLimits extends ShapeLimits {
  readonly maxBatch: number;
  readonly maxPayloadBytes: number;
}

/** A priority as the INTEGER column holds it: the payload keeps no other copy, so out-of-range clamps. */
export function priorityColumn(priority: number): number {
  return Math.min(MAX_INTEGER, Math.max(MIN_INTEGER, priority));
}

function text(name: string, value: unknown, limit = Number.POSITIVE_INFINITY): string {
  if (typeof value !== 'string' || value === '') {
    throw new UnsupportedOptionError(name, 'must be a non-empty string');
  }
  if (value.includes('\0')) throw new UnsupportedOptionError(name, 'must not contain NUL');
  if (value.length > limit) throw new UnsupportedOptionError(name, `is over ${limit} characters`);
  if (LONE_SURROGATE.test(value))
    throw new UnsupportedOptionError(name, 'must be well-formed Unicode');
  return value;
}

/** A queue name, owner or other identifier a caller passes: non-empty, no NUL, bounded. */
export function identifier(name: string, value: unknown): string {
  return text(name, value, MAX_IDENTIFIER_CHARS);
}

function groupId(value: string | number): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new UnsupportedOptionError('group.id', 'must be a string or a safe integer');
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new UnsupportedOptionError('group.id', 'must be a string or a safe integer');
  }
  return text('group.id', String(value), MAX_IDENTIFIER_CHARS);
}

export function backoffOf(backoff: JobOptions['backoff']): Envelope['backoff'] {
  if (backoff === undefined) return { type: 'fixed', delay: DEFAULT_BACKOFF_MS };
  if (typeof backoff === 'number') return { type: 'fixed', delay: backoff };
  return backoff.maxDelay === undefined
    ? { type: backoff.type, delay: backoff.delay }
    : { type: backoff.type, delay: backoff.delay, maxDelay: backoff.maxDelay };
}

function envelopeOf(job: NewJob, name: string, options: JobOptions): Envelope {
  const { deduplication, group } = options;
  return {
    v: 1,
    name,
    data: job.data,
    backoff: backoffOf(options.backoff),
    ...(options.stallTimeout !== undefined && { stallTimeout: options.stallTimeout }),
    ...(deduplication && {
      dedup: {
        ...(deduplication.ttl !== undefined && { ttl: deduplication.ttl }),
        ...(deduplication.extend !== undefined && { extend: deduplication.extend }),
        ...(deduplication.replace !== undefined && { replace: deduplication.replace }),
      },
    }),
    ...(group?.maxSize !== undefined && { groupMaxSize: group.maxSize }),
    ...(options.removeOnComplete !== undefined && { removeOnComplete: options.removeOnComplete }),
    ...(options.removeOnFail !== undefined && { removeOnFail: options.removeOnFail }),
    ...(job.trace !== undefined && { trace: job.trace }),
  };
}

function prepareOne(job: NewJob, index: number, codec: Codec, limits: PrepareLimits): PreparedJob {
  const queue = text('queue', job.queue, MAX_IDENTIFIER_CHARS);
  const name =
    job.name === undefined ? DEFAULT_JOB_NAME : text('name', job.name, MAX_IDENTIFIER_CHARS);
  const options = validateJobOptions(job.options);
  if (job.trace !== undefined) text('trace', job.trace, MAX_IDENTIFIER_CHARS);
  const envelope = envelopeOf(job, name, options);
  const shape = overShape(job.data, limits);
  if (shape) throw new PayloadTooComplexError(shape.kind, shape.limit, index);
  let payload: Uint8Array;
  try {
    payload = codec.encode(envelope);
  } catch (error) {
    throw new StoreError(`the payload of job ${index} cannot be encoded`, { cause: error });
  }
  if (payload.byteLength > limits.maxPayloadBytes) {
    throw new PayloadTooLargeError(payload.byteLength, limits.maxPayloadBytes, index);
  }
  const { deduplication, group } = options;
  const grouped = group ? groupId(group.id) : null;
  return {
    index,
    customId:
      options.jobId === undefined ? null : text('jobId', options.jobId, MAX_IDENTIFIER_CHARS),
    queue,
    payload,
    priority: priorityColumn(group?.priority ?? options.priority ?? 0),
    lifo: options.lifo ?? false,
    delayMs: Math.floor(Math.max(0, options.delay ?? 0)),
    maxAttempts: options.attempts ?? 1,
    timeout: options.timeout ?? null,
    dedupKey: deduplication
      ? text('deduplication.id', deduplication.id, MAX_IDENTIFIER_CHARS)
      : null,
    dedupTtl: deduplication?.ttl ?? null,
    dedupExtend: deduplication?.extend ?? false,
    dedupReplace: deduplication?.replace ?? false,
    groupId: grouped,
    groupMaxSize: grouped === null ? null : (group?.maxSize ?? null),
    envelope,
    own: {
      attempts: options.attempts !== undefined,
      backoff: options.backoff !== undefined,
      timeout: options.timeout !== undefined,
    },
  };
}

/**
 * Validates and encodes every job before any connection is used, so a bad job fails the whole call
 * with nothing admitted and no transaction held open while the codec runs.
 */
export function prepareJobs(
  jobs: readonly NewJob[],
  codec: Codec,
  limits: PrepareLimits
): PreparedJob[] {
  if (jobs.length > limits.maxBatch) throw new BatchTooLargeError(jobs.length, limits.maxBatch);
  return jobs.map((job, index) => prepareOne(job, index, codec, limits));
}
