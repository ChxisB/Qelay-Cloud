import { useCallback } from 'react';
import { bq } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { usePolledData } from '@/lib/usePolledData';
import { JOBS_PAGE_SIZE, type JobStatusFilter } from './model';

interface JobsPage {
  view: string;
  jobs: JobFull[];
  /** When this page was fetched, for the "updated Ns ago" line. */
  at: number;
}

/**
 * One server-paginated page of a queue's jobs, polled. The result is tagged with the view it
 * was fetched for (queue|status|page), so switching any of them can't leave the previous
 * view's rows rendered — with live action buttons — under the new selection for one round-trip.
 */
export function useJobsPage(queue: string, status: JobStatusFilter, page: number) {
  const view = `${queue}|${status}|${page}`;
  const fetcher = useCallback(async (): Promise<JobsPage> => {
    if (!queue) return { view, jobs: [], at: Date.now() };
    const states = status === 'all' ? undefined : [status];
    const r = await bq.jobsList(queue, states, JOBS_PAGE_SIZE, page * JOBS_PAGE_SIZE);
    return {
      view,
      jobs: (r.jobs ?? []).map((j) => ({ ...j, queue: j.queue ?? queue })),
      at: Date.now(),
    };
  }, [queue, status, page, view]);
  const { data, error, loading, refetch } = usePolledData(fetcher, [queue, status, page]);
  const current = data?.view === view ? data : null;
  return { jobs: current?.jobs ?? null, updatedAt: current?.at ?? null, error, loading, refetch };
}
