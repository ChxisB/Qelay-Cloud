import { ApiError } from '../errors';
import type { Route } from '../http/router';
import type { JobsContext } from '../jobs/context';
import { requestsQuery, toRequestDetailWire, toRequestWire } from '../jobs/sourceModel';
import type { Role } from '../types';

const notFound = (id: string): ApiError =>
  new ApiError(404, 'request_not_found', 'request not found', { requestId: id });

/**
 * Requests an inbound source took (DESIGN.md D12 and D14). `GET /requests` pages newest first by keyset (`next` goes back in
 * as `before`, so a request that arrives meanwhile moves no page) and holds no headers, query or body. `GET /requests/:id`
 * is one request whole with the deliveries it made; its body is shown to an operator only, since it is what a stranger
 * sent. `POST /requests/:id/replay` makes new deliveries for the source's routes as they are now, without the dedupe: the
 * operator asked for it. A rejected request kept no body, so it is a 409.
 */
export function requestRoutes(ctx: JobsContext): Route[] {
  const { store } = ctx;
  const roleOf = (principal: { readonly role: Role } | null): Role => principal?.role ?? 'viewer';

  return [
    {
      method: 'GET',
      path: '/requests',
      access: 'read',
      async handle(context) {
        const { source, ...query } = context.query(requestsQuery);
        const page = await store.sources.requests({
          ...(source === undefined ? {} : { sourceId: source }),
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.before === undefined ? {} : { before: query.before }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        });
        return { ok: true, data: { requests: page.items.map(toRequestWire), next: page.next } };
      },
    },
    {
      method: 'GET',
      path: '/requests/:id',
      access: 'read',
      async handle({ params, principal }) {
        const request = await store.sources.request(params.id!);
        if (request === null) throw notFound(params.id!);
        return { ok: true, data: { request: toRequestDetailWire(request, roleOf(principal)) } };
      },
    },
    {
      method: 'POST',
      path: '/requests/:id/replay',
      access: 'write',
      async handle({ params }) {
        const result = await store.sources.replay(params.id!);
        if (result.outcome === 'not_found') throw notFound(params.id!);
        if (result.outcome === 'rejected') {
          throw new ApiError(
            409,
            'request_not_replayable',
            'the request was rejected and kept no body, so there is nothing to replay',
            { requestId: params.id! }
          );
        }
        // Queued, not sent: the next tick sends the deliveries.
        return Response.json(
          { ok: true, data: { routes: result.routes, deliveries: result.deliveries } },
          { status: 202 }
        );
      },
    },
  ];
}
