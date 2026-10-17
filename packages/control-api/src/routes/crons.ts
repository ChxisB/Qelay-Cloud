import { ApiError } from '../errors';
import type { Route } from '../http/router';
import type { JobsContext } from '../jobs/context';
import { cronBody, toCronSpec, toCronWire } from '../jobs/cronModel';

/** Most crons one list answers with; `truncated` says when there were more. */
const MAX_LISTED_CRONS = 1_000;

const cronNotFound = (name: string): ApiError =>
  new ApiError(404, 'cron_not_found', 'cron not found', { name });

/**
 * Recurring jobs. Creating and replacing are one upsert in the store, so `POST /crons` and
 * `PUT /crons/:name` differ only in where the name comes from: the first answers 201 for a new cron
 * and 200 for a replaced one (read just before the write, so it is advice under a race), the second
 * is 200 either way. An unchanged timing keeps `nextRun` and `executions`; changed timing is
 * recomputed from now. The store validates everything a stored cron needs to fire, so a bad
 * expression, an unknown time zone or a template key it does not take is 400 `unsupported_option`
 * naming the option, and nothing is written.
 *
 * `nextRun` is the store's own computation, the one the tick fires by, so what the page shows is
 * what happens. `data` is not returned: it can be as large as a job's payload.
 */
export function cronRoutes(ctx: JobsContext): Route[] {
  const { store } = ctx;

  return [
    {
      method: 'GET',
      path: '/crons',
      access: 'read',
      async handle() {
        const crons = await store.crons.list();
        return {
          ok: true,
          crons: crons.slice(0, MAX_LISTED_CRONS).map(toCronWire),
          total: crons.length,
          truncated: crons.length > MAX_LISTED_CRONS,
        };
      },
    },
    {
      method: 'GET',
      path: '/crons/:name',
      access: 'read',
      async handle(context) {
        const name = context.params.name!;
        const cron = await store.crons.get(name);
        if (cron === null) throw cronNotFound(name);
        return { ok: true, cron: toCronWire(cron) };
      },
    },
    {
      method: 'POST',
      path: '/crons',
      access: 'write',
      async handle(context) {
        const spec = toCronSpec(await context.json(cronBody));
        context.audit(spec.name);
        const existed = (await store.crons.get(spec.name)) !== null;
        const cron = await store.crons.upsert(spec);
        return Response.json({ ok: true, cron: toCronWire(cron) }, { status: existed ? 200 : 201 });
      },
    },
    {
      method: 'PUT',
      path: '/crons/:name',
      access: 'write',
      async handle(context) {
        const name = context.params.name!;
        const spec = toCronSpec(await context.json(cronBody), name);
        const cron = await store.crons.upsert(spec);
        return { ok: true, cron: toCronWire(cron) };
      },
    },
    {
      method: 'DELETE',
      path: '/crons/:name',
      access: 'write',
      async handle(context) {
        const name = context.params.name!;
        // The jobs it already created stay: deleting a cron stops the next occurrences only.
        if (!(await store.crons.delete(name))) throw cronNotFound(name);
        return { ok: true };
      },
    },
  ];
}
