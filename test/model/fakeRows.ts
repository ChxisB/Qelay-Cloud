import type { JobRecord, JobState, StateCounts } from '@qelay-cloud/core';
import { JOB_STATES } from '@qelay-cloud/core';

export interface Row {
  readonly id: string;
  readonly queue: string;
  readonly name: string;
  readonly createdAt: number;
  readonly data: unknown;
  readonly lifo: boolean;
  readonly maxAttempts: number;
  readonly backoffMs: number;
  priority: number;
  runAt: number;
  attempts: number;
  status: 'pending' | 'active' | 'completed' | 'failed';
  leaseToken: string | null;
  leaseOwner: string | null;
  leaseUntil: number | null;
  leaseRenewals: number;
  /** When a doorbell for this job is deliverable (`markRung`), or null if none was reported. */
  rungAt: number | null;
}

export function stateOfRow(row: Row, now: number): JobState {
  if (row.status !== 'pending') return row.status;
  if (row.runAt > now) return 'delayed';
  return row.priority > 0 ? 'prioritized' : 'waiting';
}

/** `ORDER BY priority DESC, lifo DESC, CASE lifo: id DESC ELSE run_at, id`. */
export function claimOrder(a: Row, b: Row): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.lifo !== b.lifo) return a.lifo ? -1 : 1;
  if (a.lifo) return a.id < b.id ? 1 : -1;
  if (a.runAt !== b.runAt) return a.runAt - b.runAt;
  return a.id < b.id ? -1 : 1;
}

export function toRecord(row: Row, now: number): JobRecord {
  const { leaseOwner, leaseUntil } = row;
  const leased = row.status === 'active' && leaseOwner !== null && leaseUntil !== null;
  return {
    id: row.id,
    queue: row.queue,
    name: row.name,
    data: row.data,
    state: stateOfRow(row, now),
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    runAt: row.runAt,
    createdAt: row.createdAt,
    lease: leased ? { owner: leaseOwner, until: leaseUntil } : null,
  };
}

export function countStates(rows: Iterable<Row>, queue: string, now: number): StateCounts {
  const counts = Object.fromEntries(JOB_STATES.map((state) => [state, 0])) as Record<
    JobState,
    number
  >;
  for (const row of rows) {
    if (row.queue === queue) counts[stateOfRow(row, now)] += 1;
  }
  return counts;
}
