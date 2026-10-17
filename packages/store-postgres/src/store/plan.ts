import type { JobState } from '@qelay-cloud/core';
import { GroupFullError } from '../errors';
import type { StoreEvent } from './events';
import type { ExistingRow } from './lookup';
import { keyOf } from './lookup';
import type { PreparedJob } from './prepare';
import { effectiveState, initialState, isLiveState, isPendingState } from './state';

/** A job this call will insert. */
export interface PlannedInsert {
  readonly job: PreparedJob;
  readonly id: string;
  readonly state: 'waiting' | 'prioritized' | 'delayed';
  readonly runAt: number;
  /** Mutable: a later duplicate in the same call may extend it. */
  uniqueExpiresAt: number | null;
  /** Set when a later job in the same call replaced this one, so it is never inserted. */
  cancelled: boolean;
}

/** What one input job came to: a new job, or the live job it duplicated. */
export type Admitted =
  | { readonly kind: 'created'; readonly insert: PlannedInsert }
  | { readonly kind: 'duplicate'; readonly id: string; readonly state: JobState };

export interface Plan {
  /** In input order, without the cancelled ones. */
  readonly inserts: PlannedInsert[];
  /** Existing rows whose whole generation (the row and what hangs off it) goes. */
  readonly deleteIds: string[];
  /** Existing rows whose dedup key is released. */
  readonly clearKeyIds: string[];
  /** Existing rows whose dedup window moves to a new expiry. */
  readonly extend: Map<string, number>;
  readonly events: StoreEvent[];
  /** One per input job, in input order. */
  readonly admitted: Admitted[];
}

export interface PlanInput {
  readonly now: number;
  readonly jobs: readonly PreparedJob[];
  readonly existingById: ReadonlyMap<string, ExistingRow>;
  readonly existingByKey: ReadonlyMap<string, ExistingRow>;
  /** Pending jobs per `keyOf(queue, groupId)`, for the groups whose `maxSize` is being checked. */
  readonly pendingByGroup: Map<string, number>;
  readonly nextId: () => string;
}

/** What admission knows about a job at this point of the call: a stored row or one planned here. */
interface Known extends ExistingRow {
  readonly insert: PlannedInsert | null;
}

const known = (row: ExistingRow, insert: PlannedInsert | null = null): Known => ({
  ...row,
  insert,
});

/**
 * Decides, without touching the database, what an enqueue call does. Jobs are taken in input
 * order against an overlay of what earlier jobs in the same call did, so two jobs with one custom
 * id or one dedup key resolve exactly as two sequential calls would. The rules are upstream's
 * (`admission.ts`): a live custom id is a duplicate; a finished one is replaced; an expired dedup
 * key is released first; a live dedup key is a duplicate, or is replaced, or has its window
 * extended, according to the new job's options.
 *
 * Throws `GroupFullError` for a job whose group is at its `maxSize`; the caller rolls back.
 */
export function planAdmission(input: PlanInput): Plan {
  const { now, existingById, existingByKey, pendingByGroup } = input;
  const byId = new Map<string, Known>([...existingById].map(([id, row]) => [id, known(row)]));
  const byKey = new Map<string, Known>([...existingByKey].map(([k, row]) => [k, known(row)]));
  const plan: Plan = {
    inserts: [],
    deleteIds: [],
    clearKeyIds: [],
    extend: new Map(),
    events: [],
    admitted: [],
  };

  const event = (type: StoreEvent['type'], row: Known, state: JobState) =>
    plan.events.push({ type, queue: row.queue, jobId: row.id, state });
  const stateOf = (row: Known) => effectiveState(row.state, row.runAt, row.priority, now);
  const duplicate = (row: Known): Admitted => {
    const state = stateOf(row);
    event('duplicated', row, state);
    return { kind: 'duplicate', id: row.id, state };
  };
  const adjustPending = (row: Known, by: number) => {
    if (row.groupId === null) return;
    const key = keyOf(row.queue, row.groupId);
    pendingByGroup.set(key, Math.max(0, (pendingByGroup.get(key) ?? 0) + by));
  };
  /** Drops a job that a replace removes: an existing row is deleted, a planned one never inserted. */
  const remove = (row: Known) => {
    event('removed', row, stateOf(row));
    if (isPendingState(row.state)) adjustPending(row, -1);
    byId.delete(row.id);
    byKey.delete(keyOf(row.queue, row.uniqueKey!));
    if (row.insert) row.insert.cancelled = true;
    else plan.deleteIds.push(row.id);
  };
  const release = (row: Known) => {
    event('updated', row, stateOf(row));
    byKey.delete(keyOf(row.queue, row.uniqueKey!));
    plan.extend.delete(row.id);
    plan.clearKeyIds.push(row.id);
  };

  for (const job of input.jobs) {
    // 1. A live job with this custom id is the answer. A finished one is replaced below.
    const sameId = job.customId === null ? undefined : byId.get(job.customId);
    if (sameId && isLiveState(sameId.state)) {
      plan.admitted.push(duplicate(sameId));
      continue;
    }

    // 2. A live job holding this dedup key.
    let holder = job.dedupKey === null ? undefined : byKey.get(keyOf(job.queue, job.dedupKey));
    if (holder && holder.uniqueExpiresAt !== null && holder.uniqueExpiresAt <= now) {
      release(holder);
      holder = undefined;
    }
    if (holder) {
      if (!job.dedupReplace) {
        if (job.dedupExtend && job.dedupTtl !== null) {
          const expiresAt = now + job.dedupTtl;
          if (holder.insert) holder.insert.uniqueExpiresAt = expiresAt;
          else plan.extend.set(holder.id, expiresAt);
        }
        plan.admitted.push(duplicate(holder));
        continue;
      }
      // Replace: an active job keeps running without its key; any other is deleted.
      if (holder.state === 'active') release(holder);
      else remove(holder);
    }

    // 3. Room in the group.
    if (job.groupId !== null && job.groupMaxSize !== null) {
      const pending = pendingByGroup.get(keyOf(job.queue, job.groupId)) ?? 0;
      if (pending >= job.groupMaxSize) {
        throw new GroupFullError(job.queue, job.groupId, job.groupMaxSize, job.index);
      }
    }

    // 4. Insert, over the finished generation of the same id if there is one.
    if (sameId) plan.deleteIds.push(sameId.id);
    const id = job.customId ?? input.nextId();
    const runAt = now + job.delayMs;
    const insert: PlannedInsert = {
      job,
      id,
      state: initialState(runAt, now, job.priority),
      runAt,
      uniqueExpiresAt: job.dedupKey !== null && job.dedupTtl !== null ? now + job.dedupTtl : null,
      cancelled: false,
    };
    const row = known(
      {
        id,
        queue: job.queue,
        state: insert.state,
        runAt,
        priority: job.priority,
        groupId: job.groupId,
        uniqueKey: job.dedupKey,
        uniqueExpiresAt: insert.uniqueExpiresAt,
      },
      insert
    );
    byId.set(id, row);
    if (job.dedupKey !== null) byKey.set(keyOf(job.queue, job.dedupKey), row);
    adjustPending(row, 1);
    plan.inserts.push(insert);
    plan.admitted.push({ kind: 'created', insert });
    event('pushed', row, insert.state);
  }

  return { ...plan, inserts: plan.inserts.filter((insert) => !insert.cancelled) };
}
