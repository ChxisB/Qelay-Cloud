import type { JobState } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';

/**
 * A change worth journaling. Each operation reports what it did and the event journal writes it in
 * the same transaction (`journal.ts`).
 *
 * `retried` is a job that failed and will run again; `stalled` one whose lease expired and will run
 * again. `failed` is the end of a job's last attempt (it is in the DLQ, or `removed` when its
 * `removeOnFail` deleted it). `removed` alone is a job deleted without finishing: TTL expiry,
 * eviction, cancel or purge from the DLQ. `promoted` is a delayed job that became claimable, ahead
 * of its time (an operator's `promote`) or at it (the tick); `priority` a pending job whose priority
 * changed.
 *
 * `progress` is an active job's progress report; it changes nothing else about the job. `obliterated`
 * is a whole queue deleted, not a job: its `jobId` is `__queue__:<queue>` and its `state` null, and a
 * reader reloads the queue from the jobs, as it does after a gap.
 */
export interface StoreEvent {
  readonly type:
    | 'pushed'
    | 'duplicated'
    | 'updated'
    | 'promoted'
    | 'priority'
    | 'removed'
    | 'pulled'
    | 'released'
    | 'completed'
    | 'retried'
    | 'stalled'
    | 'failed'
    | 'progress'
    | 'obliterated';
  readonly queue: string;
  readonly jobId: string;
  /** The state the job is in after the change; for a deleted job, the state it was deleted from. Null for `obliterated`. */
  readonly state: JobState | null;
  /** For `progress`: the number stored, 0 to 100. */
  readonly progress?: number;
  readonly error?: string;
  /** The job row was deleted by the change. */
  readonly removed?: true;
}

/**
 * Called inside the operation's transaction, after the writes and before commit, so a recorder
 * that throws rolls the whole operation back and a recorded event never describes a lost write.
 */
export interface EventRecorder {
  record(tx: TransactionSQL, events: readonly StoreEvent[], now: number): Promise<void>;
}

export const noopRecorder: EventRecorder = { record: async () => {} };
