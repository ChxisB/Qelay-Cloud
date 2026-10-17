import type { WorkerInfo } from '@qelay-cloud/store-postgres';

/**
 * A worker as the panel's workers page reads it (`WorkerFull` of
 * `../qelay-control-panel/src/lib/bqTypes.ts`). The registry row is the worker's own claim to be
 * alive: `status` is `stale` when its last heartbeat is older than the store's active window, and
 * the tick deletes the row at the expire window, after which it is gone from the list.
 */
export interface WorkerWire {
  readonly id: string;
  readonly name: string;
  readonly queues: readonly string[];
  readonly concurrency: number;
  readonly hostname: string;
  readonly pid: number;
  readonly status: 'active' | 'stale';
  readonly registeredAt: number;
  readonly lastSeen: number;
  readonly activeJobs: number;
  readonly processedJobs: number;
  readonly failedJobs: number;
  /** Always null: the registry counts a worker's active jobs and does not name them. */
  readonly currentJob: null;
  /** Milliseconds since it registered, by this service's clock. Never negative. */
  readonly uptime: number;
}

export const toWorkerWire = (worker: WorkerInfo, now: number): WorkerWire => ({
  id: worker.id,
  name: worker.name,
  queues: worker.queues,
  concurrency: worker.concurrency,
  hostname: worker.hostname,
  pid: worker.pid,
  status: worker.active ? 'active' : 'stale',
  registeredAt: worker.registeredAt,
  lastSeen: worker.lastSeen,
  activeJobs: worker.activeJobs,
  processedJobs: worker.processed,
  failedJobs: worker.failed,
  currentJob: null,
  uptime: Math.max(0, now - worker.registeredAt),
});
