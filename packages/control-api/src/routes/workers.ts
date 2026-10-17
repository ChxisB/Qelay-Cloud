import type { Route } from '../http/router';
import type { JobsContext } from '../jobs/context';
import { toWorkerWire } from '../jobs/workerModel';

/**
 * The worker registry. `GET /workers` answers the panel's `{ ok, data: { workers, stats } }`: every
 * registered worker (at most the store's cap), `stale` ones included until the tick deletes them.
 *
 * `DELETE /workers/:id` removes the row, which is all unregistering does here: a worker that is
 * still running registers again on its next heartbeat, and a job it holds is recovered by its lease
 * and not by this call. A worker that is already gone is not an error (`removed: false`), because
 * the list the operator clicked on was a moment old and the outcome they asked for is the same.
 */
export function workerRoutes(ctx: JobsContext): Route[] {
  const { store, clock } = ctx;

  return [
    {
      method: 'GET',
      path: '/workers',
      access: 'read',
      async handle() {
        const found = await store.workers.list();
        const now = clock.now();
        const workers = found.map((worker) => toWorkerWire(worker, now));
        const active = workers.filter((worker) => worker.status === 'active').length;
        return {
          ok: true,
          data: {
            workers,
            stats: { total: workers.length, active, stale: workers.length - active },
          },
        };
      },
    },
    {
      method: 'DELETE',
      path: '/workers/:id',
      access: 'write',
      async handle(context) {
        const removed = await store.workers.remove(context.params.id!);
        return { ok: true, removed };
      },
    },
  ];
}
