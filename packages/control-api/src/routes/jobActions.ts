import type { OperatorOptions } from '@qelay-cloud/core';
import { ApiError } from '../errors';
import type { Route } from '../http/router';
import {
  fencedBody,
  fencedQuery,
  jobDataBody,
  jobDelayBody,
  jobPriorityBody,
} from '../jobs/actionSchemas';
import type { JobsContext } from '../jobs/context';
import { explainRefusal, jobNotFound } from '../jobs/context';
import { fromWire } from '../jobs/payload';
import { ringAfterCommit } from '../jobs/ring';

const fence = (expectedVersion: number | undefined): OperatorOptions =>
  expectedVersion === undefined ? {} : { expectedVersion };

/** What a panel action the store has no operation for answers: 501 naming it, never a silent no-op. */
const closed =
  (action: string, why: string): Route['handle'] =>
  () => {
    throw ApiError.notSupported(action, why);
  };

/**
 * Operator actions on one job. Each takes `expectedVersion` (the job's `version`, as read): when the
 * job has moved on, the answer is 409 `version_conflict` and nothing changed. Without it the action
 * applies to whatever the job is now, as the panel sends it. An action the job's state does not take
 * is 409 `job_state` naming the state, and an unknown id is 404.
 *
 * - `PUT data`: any job that is not finished, including an active one (its lease is untouched).
 * - `PUT priority`: a waiting, prioritized or delayed job.
 * - `PUT delay`: a delayed job, moved to now plus `delay`. `POST promote` makes it due now.
 * - `DELETE`: removes a job in any state but active, and a job a live flow parent waits on is 409.
 *
 * Fail, discard, move-to-wait and move-to-delayed have no equivalent: a failure is a worker's report
 * under its lease, and a retry of a failed job is closed (DESIGN.md "Parity first").
 */
export function jobActionRoutes(ctx: JobsContext): Route[] {
  const { store } = ctx;

  return [
    {
      method: 'PUT',
      path: '/jobs/:id/data',
      access: 'write',
      async handle(context) {
        const id = context.params.id!;
        const body = await context.json(jobDataBody);
        const changed = await store.control.updateData(
          id,
          fromWire(body.data),
          fence(body.expectedVersion)
        );
        return changed ? { ok: true } : explainRefusal(ctx, id);
      },
    },
    {
      method: 'PUT',
      path: '/jobs/:id/priority',
      access: 'write',
      async handle(context) {
        const id = context.params.id!;
        const body = await context.json(jobPriorityBody);
        if (body.lifo !== undefined) {
          const job = await store.control.details(id);
          if (job === null) throw jobNotFound(id);
          if ((job.options.lifo ?? false) !== body.lifo) {
            throw ApiError.notSupported(
              'lifo',
              'the order of a job within its priority is fixed when it is added'
            );
          }
        }
        const changed = await store.changePriority(id, body.priority, fence(body.expectedVersion));
        return changed ? { ok: true } : explainRefusal(ctx, id);
      },
    },
    {
      method: 'PUT',
      path: '/jobs/:id/delay',
      access: 'write',
      async handle(context) {
        const id = context.params.id!;
        const body = await context.json(jobDelayBody);
        const outcome = await store.control.changeDelay(
          id,
          body.delay,
          fence(body.expectedVersion)
        );
        if (!outcome.ok) return explainRefusal(ctx, id);
        await ringAfterCommit(store, ctx.transport, ctx.logger, outcome.rings);
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/jobs/:id/promote',
      access: 'write',
      async handle(context) {
        const id = context.params.id!;
        const body = await context.json(fencedBody);
        const outcome = await store.promote(id, fence(body?.expectedVersion));
        if (!outcome.ok) return explainRefusal(ctx, id);
        await ringAfterCommit(store, ctx.transport, ctx.logger, outcome.rings);
        return { ok: true };
      },
    },
    {
      method: 'DELETE',
      path: '/jobs/:id',
      access: 'write',
      async handle(context) {
        const id = context.params.id!;
        const query = context.query(fencedQuery);
        const result = await store.control.remove(id, fence(query.expectedVersion));
        if (result === 'removed') return { ok: true };
        if (result === 'not-found') throw jobNotFound(id);
        if (result === 'protected') {
          throw new ApiError(
            409,
            'flow_protected',
            'a live flow parent still waits on it, so nothing was changed',
            { jobId: id }
          );
        }
        return explainRefusal(ctx, id);
      },
    },
    {
      method: 'POST',
      path: '/jobs/:id/fail',
      access: 'write',
      handle: closed('job-fail', 'a job fails when its worker reports it, under the worker lease'),
    },
    {
      method: 'POST',
      path: '/jobs/:id/discard',
      access: 'write',
      handle: closed('job-discard', 'a job is removed with DELETE /jobs/:id'),
    },
    {
      method: 'POST',
      path: '/jobs/:id/move-to-wait',
      access: 'write',
      handle: closed('job-retry', 'retrying a failed job is closed until task 14 (k) is revisited'),
    },
    {
      method: 'POST',
      path: '/jobs/:id/move-to-delayed',
      access: 'write',
      handle: closed(
        'job-move-to-delayed',
        'a delayed job is rescheduled with PUT /jobs/:id/delay'
      ),
    },
  ];
}
