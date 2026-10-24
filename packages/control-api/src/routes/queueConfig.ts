import { ApiError } from '../errors';
import type { Route } from '../http/router';
import {
  dlqConfigBody,
  queuePolicyBody,
  runWindowBody,
  stallConfigBody,
} from '../jobs/actionSchemas';
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
 * DLQ: `maxAge` and `maxEntries` are the retention and are saved. A value equal to the current one is
 * a no-op (the form sends the whole object). Lowering `maxEntries` deletes the oldest entries at once,
 * in the same transaction, as the tick would; the entry a live flow parent waits on is kept. Auto-retry
 * is closed: `autoRetry: true` is 501 `dlq-auto-retry`, and the interval and count of it are fixed.
 *
 * Policy: the attempts, backoff and timeout a job gets when it sets none of its own, applied when the job is
 * added (DESIGN.md D17). `PUT` replaces the whole policy and `{}` removes it.
 *
 * Run window: when the queue may start jobs, as a cron, a duration and a zone (D17). `PUT` replaces it and `DELETE`
 * removes it. The answer says whether it is open now and when it next opens or closes.
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
            'DLQ entries are not retried by the service on their own: retry them with POST /queues/:queue/dlq/retry'
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
        // A value equal to the current one is left out, so a form that sends the whole object saves nothing it did not change.
        const patch: { maxAge?: number | null; maxEntries?: number } = {};
        if (body.maxAge !== undefined && body.maxAge !== current.maxAge) patch.maxAge = body.maxAge;
        if (body.maxEntries !== undefined && body.maxEntries !== current.maxEntries) {
          patch.maxEntries = body.maxEntries;
        }
        if (Object.keys(patch).length === 0) return { ok: true, config: current };
        context.audit(`dlqConfig ${Object.keys(patch).join(',')}`);
        return { ok: true, config: toDlqConfigWire(await store.queues.setDlqConfig(queue, patch)) };
      },
    },
    {
      method: 'GET',
      path: '/queues/:queue/policy',
      access: 'read',
      async handle(context) {
        return { ok: true, policy: await store.queues.policy(context.params.queue!) };
      },
    },
    {
      method: 'PUT',
      path: '/queues/:queue/policy',
      access: 'write',
      async handle(context) {
        const queue = context.params.queue!;
        const body = await context.json(queuePolicyBody);
        const policy = await store.queues.setPolicy(queue, body);
        context.audit(
          policy === null ? 'policy removed' : `policy ${Object.keys(policy).join(',')}`
        );
        return { ok: true, policy };
      },
    },
    {
      method: 'GET',
      path: '/queues/:queue/run-window',
      access: 'read',
      async handle(context) {
        return { ok: true, runWindow: await store.queues.runWindow(context.params.queue!) };
      },
    },
    {
      method: 'PUT',
      path: '/queues/:queue/run-window',
      access: 'write',
      async handle(context) {
        const body = await context.json(runWindowBody);
        const runWindow = await store.queues.setRunWindow(context.params.queue!, body);
        context.audit(`runWindow ${runWindow?.cron ?? ''} for ${runWindow?.durationMs ?? 0}ms`);
        return { ok: true, runWindow };
      },
    },
    {
      method: 'DELETE',
      path: '/queues/:queue/run-window',
      access: 'write',
      async handle(context) {
        await store.queues.setRunWindow(context.params.queue!, null);
        context.audit('runWindow removed');
        return { ok: true, runWindow: null };
      },
    },
  ];
}
