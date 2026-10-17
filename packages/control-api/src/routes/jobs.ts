import { MAX_FLOW_JOBS } from '@qelay-cloud/core';
import type { JobDetails } from '@qelay-cloud/store-postgres';
import type { Route } from '../http/router';
import { jobLogBody, jobProgressBody } from '../jobs/actionSchemas';
import type { JobsContext } from '../jobs/context';
import { explainRefusal, jobNotFound } from '../jobs/context';
import { toJobWire } from '../jobs/model';
import { listQuery, readJobPage } from '../jobs/pagination';
import { toWire } from '../jobs/payload';

/**
 * What the job inspector reads: one job in full, its result, logs and children, and the jobs of a
 * queue as a page. A job is read by its id, and a job's id is its custom id when it has one, so
 * `/jobs/:id` and `/jobs/custom/:customId` are the same lookup (a custom id is unique in the
 * namespace). The payloads are bounded: a job's own response carries up to `detailPayloadBytes` of
 * each, a list `listPayloadBytes`, and what is cut is replaced by a marker with `truncated: true`.
 */
export function jobReadRoutes(ctx: JobsContext): Route[] {
  const { store, config } = ctx;

  async function inspect(id: string) {
    const [details, failure, children] = await Promise.all([
      store.control.details(id),
      store.control.failure(id),
      store.flows.childIds(id, MAX_FLOW_JOBS),
    ]);
    if (details === null) throw jobNotFound(id);
    return {
      ok: true,
      job: toJobWire(details, { payloadBytes: config.detailPayloadBytes, failure, children }),
    };
  }

  async function existing(id: string): Promise<JobDetails> {
    const details = await store.control.details(id);
    if (details === null) throw jobNotFound(id);
    return details;
  }

  return [
    {
      method: 'GET',
      path: '/queues/:queue/jobs/list',
      access: 'read',
      async handle(context) {
        const query = context.query(listQuery);
        const page = await readJobPage(store, context.params.queue!, query, config);
        return {
          ok: true,
          jobs: page.jobs.map((job) => toJobWire(job, { payloadBytes: config.listPayloadBytes })),
          limit: page.limit,
          ...(page.offset === undefined ? {} : { offset: page.offset, total: page.total }),
          ...(page.next === undefined ? {} : { next: page.next }),
        };
      },
    },
    {
      method: 'GET',
      path: '/jobs/custom/:customId',
      access: 'read',
      handle: (context) => inspect(context.params.customId!),
    },
    {
      method: 'GET',
      path: '/jobs/:id',
      access: 'read',
      handle: (context) => inspect(context.params.id!),
    },
    {
      method: 'GET',
      path: '/jobs/:id/result',
      access: 'read',
      async handle(context) {
        const job = await existing(context.params.id!);
        const result =
          job.returnValue === null || job.returnValue === undefined
            ? null
            : toWire(job.returnValue, { maxBytes: config.detailPayloadBytes });
        return {
          ok: true,
          // The inspector checks the id it asked for, as Qelay's answer carries it.
          id: job.id,
          result: result === null ? null : result.value,
          truncated: result?.truncated ?? false,
        };
      },
    },
    {
      method: 'GET',
      path: '/jobs/:id/logs',
      access: 'read',
      async handle(context) {
        const id = context.params.id!;
        const [logs, job] = await Promise.all([store.logs.list(id), store.getJob(id)]);
        if (job === null) throw jobNotFound(id);
        return { ok: true, data: { logs, count: logs.length } };
      },
    },
    {
      method: 'GET',
      path: '/jobs/:id/children',
      access: 'read',
      async handle(context) {
        const id = context.params.id!;
        await existing(id);
        // What the completed children returned, by "<queue>:<id>". Each value is bounded like a
        // list's payloads, so a parent of many large results cannot make one response of them all.
        const values: Record<string, unknown> = {};
        let truncated = false;
        for (const [key, value] of Object.entries(await store.flows.childrenValues(id))) {
          const bounded = toWire(value, { maxBytes: config.listPayloadBytes });
          values[key] = bounded.value;
          truncated ||= bounded.truncated;
        }
        return { ok: true, data: { values }, ...(truncated ? { truncated } : {}) };
      },
    },
    {
      method: 'POST',
      path: '/jobs/:id/logs',
      access: 'write',
      async handle(context) {
        const id = context.params.id!;
        const body = await context.json(jobLogBody);
        if (!(await store.logs.add(id, body.message, body.level))) throw jobNotFound(id);
        return { ok: true };
      },
    },
    {
      method: 'DELETE',
      path: '/jobs/:id/logs',
      access: 'write',
      async handle(context) {
        const id = context.params.id!;
        const job = await store.getJob(id);
        if (job === null) throw jobNotFound(id);
        return { ok: true, count: await store.logs.clear(id) };
      },
    },
    {
      method: 'POST',
      path: '/jobs/:id/progress',
      access: 'write',
      async handle(context) {
        const id = context.params.id!;
        const body = await context.json(jobProgressBody);
        if (!(await store.control.updateProgress(id, body.progress, body.message))) {
          return explainRefusal(ctx, id);
        }
        return { ok: true };
      },
    },
  ];
}
