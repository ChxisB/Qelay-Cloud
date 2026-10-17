import type { JobRecord, JobState } from '@qelay-cloud/core';
import {
  FlowProtectedError,
  JobNotFoundError,
  JobStateError,
  UnsupportedOptionError,
  validateJobOptions,
} from '@qelay-cloud/core';
import type { LogLevel } from '@qelay-cloud/store-postgres';
import { ringAfterCommit } from './ring';
import type { Runtime } from './runtime';

/**
 * What one job accepts, by id. Job ids are unique per namespace, not per queue, so each operation
 * first checks that the job belongs to this queue: a `Queue` never sees or changes another queue's job.
 * That is one read before the write; the job's queue cannot change, so only a job removed and
 * re-created under the same custom id in another queue between the two could be missed.
 *
 * Operations a job cannot take in its state (promote a job that is not delayed, change the priority
 * of an active one, update the progress of a waiting one) resolve and change nothing, as Qelay's do.
 * `updateData` is the exception: Qelay throws, and so does this.
 */

export type JobStateName = JobState | 'unknown';

export async function ownedRecord(rt: Runtime, id: string): Promise<JobRecord | null> {
  const record = await rt.store.getJob(id);
  return record !== null && record.queue === rt.name ? record : null;
}

export async function stateOf(rt: Runtime, id: string): Promise<JobStateName> {
  return (await ownedRecord(rt, id))?.state ?? 'unknown';
}

export async function updateProgress(
  rt: Runtime,
  id: string,
  progress: unknown,
  message?: string
): Promise<void> {
  if ((await ownedRecord(rt, id)) === null) return;
  await rt.store.control.updateProgress(id, progress, message);
}

/** Returns how many lines the job holds afterwards. */
export async function addLog(
  rt: Runtime,
  id: string,
  message: string,
  level?: LogLevel
): Promise<number> {
  if ((await ownedRecord(rt, id)) === null || !(await rt.store.logs.add(id, message, level))) {
    throw new JobNotFoundError(id);
  }
  return (await rt.store.logs.list(id)).length;
}

export async function removeJob(rt: Runtime, id: string): Promise<void> {
  if ((await ownedRecord(rt, id)) === null) return;
  const result = await rt.store.control.remove(id);
  if (result === 'active') throw new JobStateError(id, 'active', 'removed');
  if (result === 'protected') {
    throw new FlowProtectedError(
      id,
      'a flow parent still waits on it: remove or finish the parent first'
    );
  }
}

export async function promoteJob(rt: Runtime, id: string): Promise<void> {
  if ((await ownedRecord(rt, id)) === null) return;
  await ringAfterCommit(rt, (await rt.store.promote(id)).rings);
}

export async function changeDelay(rt: Runtime, id: string, delay: number): Promise<void> {
  validateJobOptions({ delay });
  if ((await ownedRecord(rt, id)) === null) return;
  await ringAfterCommit(rt, (await rt.store.control.changeDelay(id, Math.max(0, delay))).rings);
}

export async function changePriority(
  rt: Runtime,
  id: string,
  options: { readonly priority: number; readonly lifo?: boolean }
): Promise<void> {
  validateJobOptions({ priority: options.priority });
  if (options.lifo !== undefined) {
    throw new UnsupportedOptionError(
      'lifo',
      'cannot be changed after the job was added (docs/compat.md)'
    );
  }
  if ((await ownedRecord(rt, id)) === null) return;
  await rt.store.changePriority(id, options.priority);
}

export async function updateData(rt: Runtime, id: string, data: unknown): Promise<void> {
  const record = await ownedRecord(rt, id);
  if (record === null) throw new JobStateError(id, null, 'updated');
  if (!(await rt.store.control.updateData(id, data))) {
    throw new JobStateError(id, record.state, 'updated');
  }
}
