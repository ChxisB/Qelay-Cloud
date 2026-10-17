import type { Codec } from '@qelay-cloud/core';

/**
 * Why an attempt ended. Adapted from Qelay's `FailureReason` (see docs/PORTING.md); only the four
 * reasons this store produces. `explicit_fail` is a worker that reported a failure, `timeout` a lease
 * that expired after the job's processing deadline, `stalled` one that expired before it, and
 * `max_attempts_exceeded` the last attempt of a job that had no more.
 */
export type FailureReason = 'explicit_fail' | 'max_attempts_exceeded' | 'timeout' | 'stalled';

/** Most attempt records a job keeps: the newest ones. The `attempts` column holds the true count. */
export const MAX_ATTEMPT_RECORDS = 20;
/** Longest error message kept, in characters. */
export const MAX_MESSAGE_CHARS = 10_000;
/** Longest stack kept, in characters. */
export const MAX_STACK_CHARS = 20_000;

export interface AttemptRecord {
  /** The attempt number, 1-based: the value of `attempts` once this attempt was counted. */
  readonly attempt: number;
  readonly startedAt: number | null;
  readonly failedAt: number;
  readonly reason: FailureReason;
  readonly error: string;
  readonly durationMs: number;
}

/**
 * What a job carries between attempts, in `qcloud_jobs.dlq_retry_state`: the history of its failed
 * attempts and how many of them were stalls (a lease that expired before the processing deadline).
 */
export interface RetryState {
  readonly attempts: readonly AttemptRecord[];
  readonly stalls: number;
}

export const EMPTY_RETRY_STATE: RetryState = { attempts: [], stalls: 0 };

/** What a failed job's `dlq_entry` holds: the final failure and the history that led to it. */
export interface DlqBlob {
  readonly v: 1;
  readonly enteredAt: number;
  readonly reason: FailureReason;
  readonly error: string;
  readonly stack?: string;
  readonly attempts: readonly AttemptRecord[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A job with no stored state, or one the codec cannot make sense of, starts from nothing. */
export function decodeRetryState(codec: Codec, bytes: Uint8Array | null): RetryState {
  if (bytes === null) return EMPTY_RETRY_STATE;
  const raw = codec.decode(bytes);
  if (!isRecord(raw)) return EMPTY_RETRY_STATE;
  const attempts = Array.isArray(raw.attempts)
    ? (raw.attempts.filter(isRecord) as unknown as AttemptRecord[]).slice(-MAX_ATTEMPT_RECORDS)
    : [];
  const stalls = typeof raw.stalls === 'number' && raw.stalls >= 0 ? Math.floor(raw.stalls) : 0;
  return { attempts, stalls };
}

/** The state after one more failed attempt: the record appended (oldest dropped past the cap). */
export function withAttempt(
  prior: RetryState,
  record: AttemptRecord,
  stalled: boolean
): RetryState {
  return {
    attempts: [...prior.attempts, record].slice(-MAX_ATTEMPT_RECORDS),
    stalls: prior.stalls + (stalled ? 1 : 0),
  };
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Text that a TEXT column and a UTF-8 codec accept: cut to `limit` characters, with NUL and lone
 * surrogates (the two things PostgreSQL refuses) replaced by U+FFFD. Anything that is not a string
 * is the empty string, so a handler that throws a non-string cannot make `fail` itself fail.
 */
export function cleanText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, limit).replaceAll('\0', '�').replace(LONE_SURROGATE, '�');
}
