import type { EnqueuedJob, JobOptions, NewJob } from '@qelay-cloud/core';
import { UnsupportedOptionError, validateJobOptions } from '@qelay-cloud/core';
import type { JobDetails } from '@qelay-cloud/store-postgres';
import type { Job } from './job';
import { createJob, fromDetails } from './job';
import { ringAfterCommit } from './ring';
import type { Runtime } from './runtime';

export interface BulkJob<T> {
  readonly name: string;
  readonly data: T;
  readonly opts?: JobOptions;
}

/**
 * Admits the jobs in one transaction, rings what needs a bell, and returns the jobs in order.
 * Every option is validated before anything is sent, so a bad one rejects the whole call. A live
 * job with the same custom id or deduplication key is returned instead of a new one, with
 * `duplicated: true`. Ringing happens after the commit and cannot fail the call: see `ringAfterCommit`.
 */
export async function addJobs<T, R = unknown>(
  rt: Runtime,
  items: ReadonlyArray<BulkJob<T>>
): Promise<Array<Job<T, R>>> {
  if (items.length === 0) return [];
  const merged = items.map((item) => {
    if (typeof item.name !== 'string') throw new UnsupportedOptionError('name', 'must be a string');
    return validateJobOptions({ ...rt.defaults, ...item.opts });
  });
  return rt.produce({ operation: 'add', queue: rt.name, count: items.length }, async (trace) => {
    const jobs: NewJob[] = items.map((item, index) => ({
      queue: rt.name,
      name: item.name,
      data: item.data,
      options: merged[index]!,
      ...(trace === undefined ? {} : { trace }),
    }));
    return admit<T, R>(rt, items, merged, jobs);
  });
}

async function admit<T, R>(
  rt: Runtime,
  items: ReadonlyArray<BulkJob<T>>,
  merged: readonly JobOptions[],
  jobs: readonly NewJob[]
): Promise<Array<Job<T, R>>> {
  const admitted = await rt.store.enqueue(jobs);
  const now = Date.now();
  await ringAfterCommit(
    rt,
    admitted.flatMap((job) => (job.ring === null ? [] : [job.ring]))
  );
  const existing = await readExisting(rt, admitted);
  return admitted.map((job, index) => {
    const item = items[index]!;
    if (!job.created) {
      const details = existing.get(job.id);
      if (details !== undefined) return fromDetails<T, R>(rt, details, true);
    }
    const opts = merged[index]!;
    return createJob<T, R>(rt, {
      id: job.id,
      name: item.name,
      data: item.data,
      opts,
      timestamp: now,
      priority: opts.priority ?? 0,
      attemptsMade: 0,
      progress: 0,
      duplicated: !job.created,
    });
  });
}

/**
 * The jobs a duplicate resolved to. A custom id is unique per namespace, so a duplicate can be a
 * job of another queue: that is an error, not a job to hand back as this queue's.
 */
async function readExisting(
  rt: Runtime,
  admitted: readonly EnqueuedJob[]
): Promise<Map<string, JobDetails>> {
  const ids = admitted.filter((job) => !job.created).map((job) => job.id);
  const found = await rt.store.control.detailsMany([...new Set(ids)]);
  for (const details of found) {
    if (details.queue !== rt.name) {
      throw new UnsupportedOptionError(
        'jobId',
        `"${details.id}" is the id of a job in queue "${details.queue}": job ids are unique per ` +
          'namespace, so it cannot be used here (docs/compat.md). Other jobs of this call were added'
      );
    }
  }
  return new Map(found.map((details) => [details.id, details]));
}

export async function addJob<T, R = unknown>(
  rt: Runtime,
  name: string,
  data: T,
  opts?: JobOptions
): Promise<Job<T, R>> {
  const [job] = await addJobs<T, R>(rt, [{ name, data, ...(opts === undefined ? {} : { opts }) }]);
  return job!;
}
