import type { ClaimedJob } from '@qelay-cloud/core';
import type { LogLevel } from '@qelay-cloud/store-postgres';
import { errorMessage } from './errorText';
import { flowReads } from './flowOps';
import type { Runtime } from './runtime';
import type { WorkerJob } from './workerOptions';

/** What the runner lets a job's context see and report. */
export interface JobControl {
  /** False once the lease is lost or the job is being released: nothing may be written for it then. */
  live(): boolean;
  readonly signal: AbortSignal;
  progressed(progress: number | object | string): void;
  logged(message: string): void;
}

/** Resolves with `work`, or with `undefined` as soon as `signal` aborts; never rejects after that. */
function unlessAborted<V>(work: Promise<V>, signal: AbortSignal): Promise<V | undefined> {
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      work.catch(() => {});
      resolve(undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/**
 * The job a processor receives. Its reports are best effort and bounded: a store failure is logged
 * and counted but never thrown into the processor (a processor's `updateProgress` cannot fail its
 * job), nothing is written once the lease is gone, and a report in flight is abandoned when the
 * signal aborts instead of holding the processor up.
 */
export function createWorkerJob<T>(
  rt: Runtime,
  claimed: ClaimedJob,
  control: JobControl
): WorkerJob<T> & { discarded: boolean } {
  const { id } = claimed;
  const report = async (what: 'progress' | 'log', write: () => Promise<unknown>) => {
    if (!control.live()) return;
    try {
      await unlessAborted(write(), control.signal);
    } catch (error) {
      rt.warn(`job ${what} not stored`, {
        jobId: id,
        error: errorMessage(error),
      });
      rt.count(`qcloud.worker.${what}_failed`);
    }
  };
  const job = {
    id,
    name: claimed.name,
    queueName: claimed.queue,
    data: claimed.data as T,
    attemptsMade: claimed.attempts,
    discarded: false,
    async updateProgress(progress: number | object | string, message?: string) {
      await report('progress', async () => {
        const stored = await rt.store.control.updateProgress(id, progress, message);
        if (stored && control.live()) control.progressed(progress);
      });
    },
    async log(message: string, level?: LogLevel) {
      await report('log', async () => {
        const stored = await rt.store.logs.add(id, message, level);
        if (stored && control.live()) control.logged(message);
      });
    },
    discard() {
      job.discarded = true;
    },
    isDiscarded: () => job.discarded,
    ...flowReads(rt, id),
  };
  return job;
}
