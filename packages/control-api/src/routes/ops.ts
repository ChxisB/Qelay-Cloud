import { z } from 'zod';
import { wantsFresh } from '../cache';
import { ApiError } from '../errors';
import type { Route } from '../http/router';
import type { OpsContext } from '../ops/context';
import { readDeadLetters } from '../ops/deadLetters';
import { readDeployment } from '../ops/deploymentView';
import { readTransport } from '../ops/transportView';

const deadLetterQuery = z.object({
  queue: z.string().min(1).max(256),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const needsStore = (what: string): ApiError =>
  new ApiError(
    501,
    'not_implemented',
    `${what} needs the jobs routes, which this deployment does not serve`
  );

const DEFAULT_SAMPLE = 25;

/**
 * The pages that say whether the doorbell path and the deployment are healthy. All three are
 * read-only and none changes a queue, a job or a broker.
 *
 * - `GET /transport`: the broker's numbers per queue next to the store's.
 * - `GET /transport/dead-letters?queue=`: a sample of the queue's poison bells. It reads the broker
 *   (a peek), and it names job ids and delivery counts, so it needs the operator role like `/audit`.
 * - `GET /deployment`: version, schema, database, connections, tick and warnings. No secret is ever
 *   part of it: it carries counts, names and thresholds, not connection strings or tokens.
 */
export function opsRoutes(ctx: OpsContext): Route[] {
  return [
    {
      method: 'GET',
      path: '/transport',
      access: 'read',
      handle: (context) => {
        if (ctx.jobs === null) throw needsStore('the transport view');
        return readTransport(ctx, wantsFresh(context.request));
      },
    },
    {
      method: 'GET',
      path: '/transport/dead-letters',
      access: 'read',
      operatorOnly: true,
      handle: (context) => {
        if (ctx.jobs === null) throw needsStore('the dead-letter view');
        const query = context.query(deadLetterQuery);
        return readDeadLetters(ctx, query.queue, query.limit ?? DEFAULT_SAMPLE);
      },
    },
    {
      method: 'GET',
      path: '/deployment',
      access: 'read',
      handle: (context) => readDeployment(ctx, wantsFresh(context.request)),
    },
  ];
}
