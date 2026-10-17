import { ApiError } from '../errors';
import type { Route } from '../http/router';
import { dlqConfigBody, stallConfigBody } from '../jobs/actionSchemas';
import type { JobsContext } from '../jobs/context';
import { toDlqConfigWire, toStallConfigWire } from '../jobs/dlqModel';

/** 400 for a setting of a form the service shows but does not have: the value is not one it can take. */
const fixed = (setting: string, value: unknown, shown: unknown): ApiError =>
  new ApiError(400, 'unsupported_option', `${setting} is not a setting of this service`, {
    option: setting,
    value,
    fixedAt: shown,
  });

/**
 * The stall and DLQ settings of a queue, as the panel's two config forms read and write them.
 *
 * Stall: `maxStalls` is the one setting. `enabled`, `stallInterval` and `gracePeriod` describe the
 * lease (always on, the store's lease length, no grace), so a save that sends them back as read is
 * accepted and one that changes them is 400 `unsupported_option`.
 *
 * DLQ: retention and auto-retry are shown and closed, as the panel treats them. A value equal to the
 * current one is a no-op (the form sends the whole object), a different `maxAge` or `maxEntries` is
 * 501 `dlq-retention` and `autoRetry: true` is 501 `dlq-auto-retry`.
 */
export function queueConfigRoutes(ctx: JobsContext): Route[] {
  const { store } = ctx;

  return [
    {
      method: 'GET',
      path: '/queues/:queue/stall-config',
      access: 'read',
      async handle(context) {
        const config = await store.queues.config(context.params.queue!);
        return { ok: true, config: toStallConfigWire(config, store.leaseMs) };
      },
    },
    {
      method: 'PUT',
      path: '/queues/:queue/stall-config',
      access: 'write',
      async handle(context) {
        const queue = context.params.queue!;
        const body = await context.json(stallConfigBody);
        if (body.enabled !== undefined && body.enabled !== true) {
          throw fixed('enabled', body.enabled, true);
        }
        if (body.stallInterval !== undefined && body.stallInterval !== store.leaseMs) {
          throw fixed('stallInterval', body.stallInterval, store.leaseMs);
        }
        if (body.gracePeriod !== undefined && body.gracePeriod !== 0) {
          throw fixed('gracePeriod', body.gracePeriod, 0);
        }
        const config = await store.queues.setStallConfig(
          queue,
          body.maxStalls === undefined ? {} : { maxStalls: body.maxStalls }
        );
        return { ok: true, config: toStallConfigWire(config, store.leaseMs) };
      },
    },
    {
      method: 'GET',
      path: '/queues/:queue/dlq-config',
      access: 'read',
      async handle(context) {
        return {
          ok: true,
          config: toDlqConfigWire(await store.queues.config(context.params.queue!)),
        };
      },
    },
    {
      method: 'PUT',
      path: '/queues/:queue/dlq-config',
      access: 'write',
      async handle(context) {
        const queue = context.params.queue!;
        const body = await context.json(dlqConfigBody);
        const current = toDlqConfigWire(await store.queues.config(queue));
        if (body.autoRetry === true) {
          throw ApiError.notSupported(
            'dlq-auto-retry',
            'DLQ entries are not retried by the service, automatically or by hand'
          );
        }
        if (body.maxAge !== undefined && body.maxAge !== current.maxAge) {
          throw ApiError.notSupported(
            'dlq-retention',
            'DLQ retention is not changed through the API: it can delete flow jobs without a dependency check'
          );
        }
        if (body.maxEntries !== undefined && body.maxEntries !== current.maxEntries) {
          throw ApiError.notSupported(
            'dlq-retention',
            'DLQ retention is not changed through the API: it can delete flow jobs without a dependency check'
          );
        }
        if (
          body.autoRetryInterval !== undefined &&
          body.autoRetryInterval !== current.autoRetryInterval
        ) {
          throw fixed('autoRetryInterval', body.autoRetryInterval, current.autoRetryInterval);
        }
        if (body.maxAutoRetries !== undefined && body.maxAutoRetries !== current.maxAutoRetries) {
          throw fixed('maxAutoRetries', body.maxAutoRetries, current.maxAutoRetries);
        }
        return { ok: true, config: current };
      },
    },
  ];
}
