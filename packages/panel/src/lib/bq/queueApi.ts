import type {
  DlqConfig,
  DlqEntryFull,
  DlqStatsFull,
  QueuePolicy,
  QueueRunWindow,
  QueueRunWindowInput,
  StallConfig,
} from '../bqTypes';
import { opaqueHttpPathSegment, queueHttpPathSegment } from '../upstreamPaths';
import { BULK_TIMEOUT_MS, body, bulkBody, srv } from './transport';

export const queueApi = {
  counts: (queue: string) =>
    srv<{ ok: boolean; counts: Record<string, number> }>(
      `/queues/${queueHttpPathSegment(queue)}/counts`
    ),
  pause: (queue: string) => srv(`/queues/${queueHttpPathSegment(queue)}/pause`, body('POST')),
  resume: (queue: string) => srv(`/queues/${queueHttpPathSegment(queue)}/resume`, body('POST')),
  // Drain, clean, obliterate and DLQ purge delete jobs for good: the Control API wants `confirm`
  // set to the queue's name (400 `confirmation_required` otherwise). The dialogs that call these
  // already make the operator type that name.
  drain: (queue: string) =>
    srv<{ ok: boolean; count: number }>(
      `/queues/${queueHttpPathSegment(queue)}/drain`,
      bulkBody('POST', { confirm: queue }),
      true,
      [],
      BULK_TIMEOUT_MS
    ),
  obliterate: (queue: string) =>
    srv(
      `/queues/${queueHttpPathSegment(queue)}/obliterate`,
      bulkBody('POST', { confirm: queue }),
      true,
      [],
      BULK_TIMEOUT_MS
    ),
  clean: (queue: string, options: { grace?: number; state?: string; limit?: number } = {}) =>
    srv<{ ok: boolean; count: number }>(
      `/queues/${queueHttpPathSegment(queue)}/clean`,
      body('POST', { ...options, confirm: queue })
    ),
  promoteJobs: (queue: string, count?: number) =>
    srv<{ ok: boolean; count: number }>(
      `/queues/${queueHttpPathSegment(queue)}/promote-jobs`,
      body('POST', count == null ? undefined : { count })
    ),
  retryCompleted: (_queue: string, _id?: string): never => {
    throw new TypeError(
      'Completed-job requeue is unavailable in Qelay because flow dependency registration is not rebuilt.'
    );
  },
  setRateLimit: (queue: string, limit: number, duration?: number, ttl?: number) =>
    srv(
      `/queues/${queueHttpPathSegment(queue)}/rate-limit`,
      body('PUT', {
        limit,
        ...(duration === undefined ? {} : { duration }),
        ...(ttl === undefined ? {} : { ttl }),
      })
    ),
  clearRateLimit: (queue: string) =>
    srv(`/queues/${queueHttpPathSegment(queue)}/rate-limit`, { method: 'DELETE' }),
  setConcurrency: (queue: string, concurrency: number) =>
    srv(`/queues/${queueHttpPathSegment(queue)}/concurrency`, body('PUT', { concurrency })),
  clearConcurrency: (queue: string) =>
    srv(`/queues/${queueHttpPathSegment(queue)}/concurrency`, { method: 'DELETE' }),
  getStallConfig: (queue: string) =>
    srv<{ ok: boolean; config: StallConfig }>(
      `/queues/${queueHttpPathSegment(queue)}/stall-config`
    ),
  setStallConfig: (queue: string, config: Partial<StallConfig>) =>
    srv(`/queues/${queueHttpPathSegment(queue)}/stall-config`, body('PUT', { config })),
  getDlqConfig: (queue: string) =>
    srv<{ ok: boolean; config: DlqConfig }>(`/queues/${queueHttpPathSegment(queue)}/dlq-config`),
  setDlqConfig: (queue: string, config: Partial<DlqConfig>) => {
    if (config.autoRetry === true) {
      throw new TypeError(
        'DLQ auto-retry is unavailable: Qelay does not rebuild flow dependency registration.'
      );
    }
    return srv(`/queues/${queueHttpPathSegment(queue)}/dlq-config`, body('PUT', { config }));
  },
  getQueuePolicy: (queue: string) =>
    srv<{ ok: boolean; policy: QueuePolicy | null }>(
      `/queues/${queueHttpPathSegment(queue)}/policy`
    ),
  /** Replaces the whole policy; `{}` removes it. */
  setQueuePolicy: (queue: string, policy: QueuePolicy) =>
    srv<{ ok: boolean; policy: QueuePolicy | null }>(
      `/queues/${queueHttpPathSegment(queue)}/policy`,
      body('PUT', policy)
    ),
  getRunWindow: (queue: string) =>
    srv<{ ok: boolean; runWindow: QueueRunWindow | null }>(
      `/queues/${queueHttpPathSegment(queue)}/run-window`
    ),
  setRunWindow: (queue: string, window: QueueRunWindowInput) =>
    srv<{ ok: boolean; runWindow: QueueRunWindow | null }>(
      `/queues/${queueHttpPathSegment(queue)}/run-window`,
      body('PUT', window)
    ),
  clearRunWindow: (queue: string) =>
    srv(`/queues/${queueHttpPathSegment(queue)}/run-window`, { method: 'DELETE' }),
  dlq: (queue: string, limit = 100, offset = 0) =>
    srv<{ ok: boolean; entries: DlqEntryFull[]; total: number }>(
      `/queues/${queueHttpPathSegment(queue)}/dlq?limit=${limit}&offset=${offset}`
    ),
  dlqStats: (queue: string) =>
    srv<{ ok: boolean; stats: DlqStatsFull }>(`/queues/${queueHttpPathSegment(queue)}/dlq/stats`),
  /** Puts one failed job back in the queue. `expectedVersion` is the entry's `job.version` as the page read it. */
  retryDlq: (queue: string, jobId: string, expectedVersion?: number) =>
    srv<{ ok: boolean }>(
      `/queues/${queueHttpPathSegment(queue)}/dlq/${opaqueHttpPathSegment(jobId)}/retry`,
      body('POST', expectedVersion === undefined ? {} : { expectedVersion })
    ),
  /** Puts up to `limit` (at most 500) failed jobs back, oldest first. `remaining` is what another call would retry. */
  retryDlqMany: (queue: string, options: { limit?: number; reason?: string } = {}) =>
    srv<{ ok: boolean; count: number; remaining: number; done: boolean }>(
      `/queues/${queueHttpPathSegment(queue)}/dlq/retry`,
      body('POST', { confirm: queue, ...options })
    ),
  purgeDlq: (queue: string) =>
    srv<{ ok: boolean; count: number }>(
      `/queues/${queueHttpPathSegment(queue)}/dlq/purge`,
      body('POST', { confirm: queue })
    ),
};
