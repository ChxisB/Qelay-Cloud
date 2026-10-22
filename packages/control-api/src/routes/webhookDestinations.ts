import { validateWebhookUrl } from '@qelay-cloud/core';
import type { WebhookUrlPolicy } from '@qelay-cloud/core';
import { ApiError } from '../errors';
import type { Route } from '../http/router';
import type { JobsContext } from '../jobs/context';
import {
  destinationBody,
  destinationPatchBody,
  toDestinationWire,
} from '../jobs/webhookDestinationModel';
import type { Role } from '../types';

const notFound = (id: string): ApiError =>
  new ApiError(404, 'destination_not_found', 'destination not found', { destinationId: id });

/**
 * Saved destinations (`docs/event-gateway.md`): `GET /webhooks/destinations` lists them with how many connections use
 * each, `POST` saves one, `PATCH /webhooks/destinations/:id` renames it or moves its address (the new address reaches
 * every connection made from it, in one transaction), and `DELETE` is refused with 409 `destination_in_use` while a
 * connection uses it. An `http` address is judged by the same policy as a webhook's, with the same 400s; the sender checks
 * again at every attempt. A read-only caller sees an address as its origin. The audit trail records the destination's id,
 * never its address. The literal path wins over `/webhooks/:id`.
 */
export function webhookDestinationRoutes(ctx: JobsContext, policy: WebhookUrlPolicy): Route[] {
  const { store } = ctx;
  const roleOf = (principal: { readonly role: Role } | null): Role => principal?.role ?? 'viewer';
  const judge = (url: string | undefined): void => {
    if (url === undefined) return;
    const verdict = validateWebhookUrl(url, policy);
    if (!verdict.ok) throw new ApiError(400, verdict.code, verdict.message, { option: 'url' });
  };

  return [
    {
      method: 'GET',
      path: '/webhooks/destinations',
      access: 'read',
      async handle({ principal }) {
        const role = roleOf(principal);
        const destinations = (await store.webhooks.destinations()).map((d) =>
          toDestinationWire(d, role)
        );
        return { ok: true, data: { destinations } };
      },
    },
    {
      method: 'POST',
      path: '/webhooks/destinations',
      access: 'write',
      async handle(context) {
        const body = await context.json(destinationBody);
        // A `queue` destination has no address to judge; one given to it is the store's 400.
        if (body.kind === 'http') judge(body.url);
        const destination = await store.webhooks.createDestination(
          {
            name: body.name,
            kind: body.kind,
            ...(body.url === undefined ? {} : { url: body.url }),
            ...(body.target === undefined ? {} : { target: body.target }),
          },
          context.principal!.subject
        );
        context.audit(`destination=${destination.id}`);
        return Response.json(
          { ok: true, data: { destination: toDestinationWire(destination, 'operator') } },
          { status: 201 }
        );
      },
    },
    {
      method: 'PATCH',
      path: '/webhooks/destinations/:id',
      access: 'write',
      async handle(context) {
        const body = await context.json(destinationPatchBody);
        judge(body.url);
        const destination = await store.webhooks.updateDestination(context.params.id!, {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.url === undefined ? {} : { url: body.url }),
          ...(body.target === undefined ? {} : { target: body.target }),
        });
        if (destination === null) throw notFound(context.params.id!);
        return { ok: true, data: { destination: toDestinationWire(destination, 'operator') } };
      },
    },
    {
      method: 'DELETE',
      path: '/webhooks/destinations/:id',
      access: 'write',
      async handle({ params }) {
        if (!(await store.webhooks.deleteDestination(params.id!))) throw notFound(params.id!);
        return { ok: true };
      },
    },
  ];
}
