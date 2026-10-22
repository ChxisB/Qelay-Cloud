import {
  previewWebhook,
  validateFilter,
  validateShape,
  validateWebhookUrl,
} from '@qelay-cloud/core';
import type { WebhookUrlPolicy } from '@qelay-cloud/core';
import { ApiError } from '../errors';
import type { Route } from '../http/router';
import type { JobsContext } from '../jobs/context';
import {
  allDeliveriesQuery,
  deliveriesQuery,
  enabledBody,
  patchBody,
  previewBody,
  retryFailedBody,
  rotateBody,
  statsQuery,
  toDeliveryWire,
  toIssuedWire,
  toWebhookWire,
  webhookBody,
} from '../jobs/webhookModel';
import type { Role } from '../types';

const webhookNotFound = (id: string): ApiError =>
  new ApiError(404, 'webhook_not_found', 'webhook not found', { webhookId: id });

/**
 * Webhooks: an operator registers a URL and the events it wants, and the maintenance tick delivers
 * them (`docs/webhooks.md`). `GET /webhooks` answers the panel's `{ ok, data: { webhooks, stats } }`.
 *
 * The address is judged here with the deployment's URL policy (https only and no private, loopback
 * or metadata destination, unless the deployment runs in development mode), so a bad one is a 400
 * naming the rule. That check is advice for the operator, not the defence: the sender checks again
 * at every attempt, against what the name resolves to then, and connects to the address it checked.
 * The name is deliberately not resolved here: a registration that told a caller whether a name
 * reaches an internal address would be a way to probe the network.
 *
 * The secret is read from the create body (or rotate body) and goes to the store, which seals it. No
 * error or audit entry carries it, and no call reads it back. The one response that carries a secret
 * is the create or rotate of a webhook given none: the store made one, and this is the only time it
 * is shown. The URL can carry a token in its path, so a
 * read-only caller sees only its origin; the audit trail records a webhook's id, never its URL.
 *
 * A webhook is a route (D11): its destination is `http` (the URL) or `queue` (a job added to `target`,
 * which has no address to judge). The store refuses a route that would loop and the error map answers
 * 409. `GET /webhooks/deliveries` and `GET /webhooks/stats` read across routes, for the console's Events
 * and Metrics screens (`GET /webhooks/stats?groupBy=webhook` is the connections list's, one entry per route);
 * the router prefers their literal paths to `/webhooks/:id`.
 */
export function webhookRoutes(ctx: JobsContext, policy: WebhookUrlPolicy): Route[] {
  const { store } = ctx;
  const roleOf = (principal: { readonly role: Role } | null): Role => principal?.role ?? 'viewer';

  return [
    {
      method: 'GET',
      path: '/webhooks',
      access: 'read',
      async handle({ principal }) {
        const role = roleOf(principal);
        const webhooks = (await store.webhooks.list()).map((hook) => toWebhookWire(hook, role));
        return {
          ok: true,
          data: {
            webhooks,
            stats: { total: webhooks.length, enabled: webhooks.filter((h) => h.enabled).length },
          },
        };
      },
    },
    {
      method: 'GET',
      path: '/webhooks/deliveries',
      access: 'read',
      async handle(context) {
        const page = await store.webhooks.deliveriesAll(
          withoutUndefined(context.query(allDeliveriesQuery))
        );
        const via = new Map(
          (await store.webhooks.list()).map((hook) => [hook.id, hook.destination])
        );
        return {
          ok: true,
          data: {
            deliveries: page.items.map((d) => toDeliveryWire(d, via.get(d.webhookId))),
            next: page.next,
          },
        };
      },
    },
    {
      method: 'GET',
      path: '/webhooks/stats',
      access: 'read',
      async handle(context) {
        const { groupBy, ...query } = context.query(statsQuery);
        if (groupBy === undefined) {
          return { ok: true, data: { stats: await store.webhooks.stats(withoutUndefined(query)) } };
        }
        if (query.webhook !== undefined) {
          throw new ApiError(400, 'invalid_request', 'webhook cannot be combined with groupBy');
        }
        const { since, until, buckets } = query;
        const grouped = await store.webhooks.statsByWebhook(
          withoutUndefined({ since, until, buckets })
        );
        return { ok: true, data: grouped };
      },
    },
    {
      method: 'GET',
      path: '/webhooks/:id',
      access: 'read',
      async handle({ params, principal }) {
        const webhook = await store.webhooks.get(params.id!);
        if (webhook === null) throw webhookNotFound(params.id!);
        return { ok: true, data: { webhook: toWebhookWire(webhook, roleOf(principal)) } };
      },
    },
    {
      method: 'POST',
      path: '/webhooks',
      access: 'write',
      async handle(context) {
        const body = await context.json(webhookBody);
        // A `queue` route has no address; one given to it, or missing from an `http` route, is the store's 400.
        if (body.url !== undefined && body.destination !== 'queue') {
          const verdict = validateWebhookUrl(body.url, policy);
          if (!verdict.ok) {
            throw new ApiError(400, verdict.code, verdict.message, { option: 'url' });
          }
        }
        const webhook = await store.webhooks.create(
          {
            ...(body.destination === undefined ? {} : { destination: body.destination }),
            ...(body.url === undefined ? {} : { url: body.url }),
            ...(body.target == null ? {} : { target: body.target }),
            ...(body.destinationId == null ? {} : { destinationId: body.destinationId }),
            events: body.events,
            ...(body.queue == null ? {} : { queue: body.queue }),
            ...(body.secret == null ? {} : { secret: body.secret }),
            ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
            ...(body.filter == null ? {} : { filter: body.filter }),
            ...(body.shape == null ? {} : { shape: body.shape }),
            ...(body.name == null ? {} : { name: body.name }),
            ...(body.description == null ? {} : { description: body.description }),
            ...(body.delayMs == null ? {} : { delayMs: body.delayMs }),
            ...(body.dedupe == null ? {} : { dedupe: body.dedupe }),
          },
          context.principal!.subject
        );
        // The entry was written before this ran, so it could not know the id.
        context.audit(`webhook=${webhook.id}`);
        return Response.json({ ok: true, data: toIssuedWire(webhook) }, { status: 201 });
      },
    },
    {
      method: 'POST',
      path: '/webhooks/preview',
      access: 'write',
      async handle(context) {
        const body = await context.json(previewBody);
        // Pure: no store, no network. A bad filter or shape is 400 `unsupported_option` naming which.
        const filter = body.filter == null ? null : validateFilter(body.filter);
        const shape = body.shape == null ? null : validateShape(body.shape);
        const { event } = body;
        const preview = previewWebhook(
          { filter, shape },
          { ...event, occurredAt: event.occurredAt ?? Date.now() }
        );
        return { ok: true, data: { preview } };
      },
    },
    {
      method: 'PATCH',
      path: '/webhooks/:id',
      access: 'write',
      async handle(context) {
        const body = await context.json(patchBody);
        // Only the named fields change. The audit entry has the webhook's id from the path, never what it was changed to.
        const webhook = await store.webhooks.update(context.params.id!, withoutUndefined(body));
        if (webhook === null) throw webhookNotFound(context.params.id!);
        return { ok: true, data: { webhook: toWebhookWire(webhook, 'operator') } };
      },
    },
    {
      method: 'PUT',
      path: '/webhooks/:id/enabled',
      access: 'write',
      async handle(context) {
        const { enabled, mode } = await context.json(enabledBody);
        const webhook = await store.webhooks.setEnabled(context.params.id!, enabled, mode);
        if (webhook === null) throw webhookNotFound(context.params.id!);
        return { ok: true, data: { webhook: toWebhookWire(webhook, 'operator') } };
      },
    },
    {
      method: 'POST',
      path: '/webhooks/:id/rotate-secret',
      access: 'write',
      async handle(context) {
        const body = (await context.json(rotateBody.optional())) ?? {};
        // The old secret keeps signing beside the new one for a day, so the receiver can switch over.
        const webhook = await store.webhooks.rotateSecret(context.params.id!, body.secret);
        if (webhook === null) throw webhookNotFound(context.params.id!);
        return { ok: true, data: toIssuedWire(webhook) };
      },
    },
    {
      method: 'DELETE',
      path: '/webhooks/:id',
      access: 'write',
      async handle({ params }) {
        // Its deliveries go with it: nothing is sent for a webhook that is gone.
        if (!(await store.webhooks.delete(params.id!))) throw webhookNotFound(params.id!);
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/webhooks/:id/test',
      access: 'write',
      async handle({ params }) {
        const delivery = await store.webhooks.sendTest(params.id!);
        if (delivery === null) throw webhookNotFound(params.id!);
        // Queued, not sent: the next tick sends it and the delivery history shows what became of it.
        return Response.json(
          { ok: true, data: { delivery: toDeliveryWire(delivery) } },
          { status: 202 }
        );
      },
    },
    {
      method: 'GET',
      path: '/webhooks/:id/deliveries',
      access: 'read',
      async handle(context) {
        const page = await store.webhooks.deliveries(
          context.params.id!,
          withoutUndefined(context.query(deliveriesQuery))
        );
        if (page === null) throw webhookNotFound(context.params.id!);
        const via = (await store.webhooks.get(context.params.id!))?.destination;
        return {
          ok: true,
          data: { deliveries: page.items.map((d) => toDeliveryWire(d, via)), next: page.next },
        };
      },
    },
    {
      method: 'POST',
      path: '/webhooks/:id/deliveries/retry',
      access: 'write',
      async handle(context) {
        const body = await context.json(retryFailedBody);
        const result = await store.webhooks.retryFailed(
          context.params.id!,
          withoutUndefined({ before: body.before, limit: body.limit })
        );
        if (result === null) throw webhookNotFound(context.params.id!);
        context.audit(`webhook=${context.params.id}`);
        return { ok: true, data: { retried: result.retried } };
      },
    },
    {
      method: 'POST',
      path: '/webhooks/:id/deliveries/:deliveryId/retry',
      access: 'write',
      async handle({ params }) {
        const result = await store.webhooks.retry(params.id!, params.deliveryId!);
        if (result.outcome === 'not_found') {
          throw new ApiError(404, 'delivery_not_found', 'delivery not found', {
            webhookId: params.id!,
            deliveryId: params.deliveryId!,
          });
        }
        if (result.outcome === 'not_failed') {
          throw new ApiError(
            409,
            'delivery_not_failed',
            `the delivery is ${result.status}, and only a failed one is retried`,
            { deliveryId: params.deliveryId!, status: result.status }
          );
        }
        return { ok: true, data: { delivery: toDeliveryWire(result.delivery) } };
      },
    },
  ];
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
