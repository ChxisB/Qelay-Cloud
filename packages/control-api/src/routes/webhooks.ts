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
  deliveriesQuery,
  enabledBody,
  previewBody,
  rotateBody,
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
        const verdict = validateWebhookUrl(body.url, policy);
        if (!verdict.ok) {
          throw new ApiError(400, verdict.code, verdict.message, { option: 'url' });
        }
        const webhook = await store.webhooks.create(
          {
            url: body.url,
            events: body.events,
            ...(body.queue == null ? {} : { queue: body.queue }),
            ...(body.secret == null ? {} : { secret: body.secret }),
            ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
            ...(body.filter == null ? {} : { filter: body.filter }),
            ...(body.shape == null ? {} : { shape: body.shape }),
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
      method: 'PUT',
      path: '/webhooks/:id/enabled',
      access: 'write',
      async handle(context) {
        const { enabled } = await context.json(enabledBody);
        const webhook = await store.webhooks.setEnabled(context.params.id!, enabled);
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
        return {
          ok: true,
          data: { deliveries: page.items.map(toDeliveryWire), next: page.next },
        };
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
