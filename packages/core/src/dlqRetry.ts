import type { Ring } from './jobs';

/** Why a DLQ retry changed nothing. */
export type DlqRetryRefusal =
  /** No such job: it was purged, or never existed. */
  | 'not_found'
  /** The job is not in the DLQ: it was retried already, or never failed. */
  | 'not_failed'
  /** `expectedVersion` is not the job's version: it moved since the caller read it. */
  | 'version'
  /** The job belongs to a flow; the flow's own `retry-failed` is the way. */
  | 'flow_member'
  /** A live job holds the same dedup key, so this one cannot be live too. */
  | 'duplicate';

/** The answer of `retryDlq`. A refusal is an answer, not an error: nothing was changed. */
export type DlqRetryResult =
  | { readonly ok: true; readonly rings: readonly Ring[] }
  | { readonly ok: false; readonly reason: DlqRetryRefusal };

export interface DlqRetryManyOptions {
  /** How many entries at most, 1 to 500. The oldest failures go first. */
  readonly limit: number;
  /** Only entries that ended for this reason (`explicit_fail`, `max_attempts_exceeded`, `timeout`, `stalled`). */
  readonly reason?: string;
}

export interface DlqRetryManyResult {
  /** The jobs put back on the queue, oldest failure first. */
  readonly retried: readonly string[];
  /** Entries that match and could still be retried, after this call. */
  readonly remaining: number;
  readonly rings: readonly Ring[];
}
