import { ApiError } from '../errors';
import type { Route } from '../http/router';
import type { NewJobInput } from '../jobs/addSchemas';
import { addJobBody, bulkRequest, toNewJob } from '../jobs/addSchemas';
import type { JobsContext } from '../jobs/context';

/**
 * Adding jobs. Both routes go through the SDK's producer, so what they do is what an application's
 * `queue.add` does: the options are validated before anything is sent, a custom id or deduplication
 * key that matches a live job answers with that job and `duplicated: true`, and the doorbell is rung
 * after the commit (a bell that fails is the tick's to ring, and never fails the add).
 *
 * A body key this store has no equivalent for (`ttl`, `repeat`, `dependsOn`, `tags`, a numeric
 * `removeOnComplete`, ...) is 400 `unsupported_option` naming it; nothing is dropped silently. A bulk
 * add is one transaction: one bad job refuses the whole request, and `details.index` says which.
 */
export function addJobRoutes(ctx: JobsContext): Route[] {
  const { config } = ctx;
  const bulk = bulkRequest(config.maxBulkJobs);

  return [
    {
      method: 'POST',
      path: '/queues/:queue/jobs',
      access: 'write',
      async handle(context) {
        const body = await context.json(addJobBody);
        const job = toNewJob(body);
        const added = await ctx.producer(context.params.queue!).add(job.name, job.data, job.opts);
        return { ok: true, id: added.id, duplicated: added.duplicated };
      },
    },
    {
      method: 'POST',
      path: '/queues/:queue/jobs/bulk',
      access: 'write',
      maxBodyBytes: config.bulkBodyBytes,
      timeoutMs: config.actionBudgetMs + 10_000,
      async handle(context) {
        const body = await context.json(bulk);
        const jobs: NewJobInput[] = body.jobs.map((job, index) => {
          try {
            return toNewJob(job);
          } catch (error) {
            if (error instanceof ApiError) {
              throw new ApiError(
                error.status,
                error.code,
                error.message,
                { ...error.details, index },
                error.headers
              );
            }
            throw error;
          }
        });
        const added = await ctx
          .producer(context.params.queue!)
          .addBulk(jobs.map((job) => ({ name: job.name, data: job.data, opts: job.opts })));
        return {
          ok: true,
          ids: added.map((job) => job.id),
          duplicated: added.flatMap((job, index) => (job.duplicated ? [index] : [])),
        };
      },
    },
  ];
}
