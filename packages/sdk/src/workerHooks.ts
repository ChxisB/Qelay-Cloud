import type { RunHooks } from './jobRunner';
import type { Runtime } from './runtime';
import type { WorkerJob } from './workerOptions';

/** What `createRunHooks` needs from the worker that owns the jobs. */
export interface HookHost {
  readonly rt: Runtime;
  emit(event: string, ...args: unknown[]): void;
  emitError(error: Error): void;
  /** A job finished: the worker counts it for its registry row. */
  settled(outcome: 'processed' | 'failed'): void;
  /** A ring after a settle, so the worker can wait for it on close. */
  track(work: Promise<void>): void;
}

/** Turns what a running job reports into the worker's events and counters. */
export function createRunHooks(host: HookHost): RunHooks {
  return {
    active: (job) => host.emit('active', job),
    completed: (job: WorkerJob, result) => {
      host.settled('processed');
      host.emit('completed', job, result);
    },
    failed: (job, error) => {
      host.settled('failed');
      host.emit('failed', job, error);
    },
    progress: (job, progress) => host.emit('progress', job, progress),
    log: (job, message) => host.emit('log', job, message),
    stalled: (jobId, reason) => host.emit('stalled', jobId, reason),
    error: (error, context) => {
      host.rt.warn('worker error', { context, error: error.message });
      host.emitError(error);
    },
    rung: (work) => host.track(work),
  };
}
