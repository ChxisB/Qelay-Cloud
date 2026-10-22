import { createHash } from 'node:crypto';
import type { WebhookDedupe, WebhookFilter, WebhookShape, WebhookSubject } from '@qelay-cloud/core';
import { dedupeValues, JOURNAL_TO_WEBHOOK, matchesFilter, renderShape } from '@qelay-cloud/core';
import type { JournalEvent } from './journal';
import { jsonOrNull } from './webhookRows';

type Time = number | string | bigint;

/** An enabled webhook as the writer reads it (`webhookWriter.ts`). */
export interface HookRow {
  readonly id: string;
  readonly events: string[];
  readonly queue: string | null;
  readonly filter: unknown;
  readonly shape: unknown;
  readonly delay_ms: Time | null;
  readonly dedupe: unknown;
  readonly active_from: Time | null;
  readonly created_at: Time;
}

interface Hook {
  readonly id: string;
  readonly events: readonly string[];
  readonly queue: string | null;
  readonly filter: WebhookFilter | null;
  readonly shape: WebhookShape | null;
  readonly delayMs: number;
  readonly dedupe: WebhookDedupe | null;
  readonly from: number;
}

/** One delivery to make. `a`: when it is due. `x` set: it is recorded as failed, with an empty body. */
export interface Planned {
  readonly w: string;
  readonly e: number;
  readonly n: string;
  readonly q: string;
  readonly j: string;
  readonly t: number;
  readonly a: number;
  readonly b: string | null;
  readonly x: string | null;
}

/** A planned delivery with the window it opens (`k` the key, `u` the end), when its webhook de-duplicates. */
export interface Candidate extends Planned {
  readonly k: string | null;
  readonly u: number;
}

const keyOf = (dedupe: WebhookDedupe, subject: WebhookSubject): string =>
  createHash('sha256').update(dedupeValues(dedupe.fields, subject)).digest('hex');

export const hookOf = (row: HookRow): Hook => ({
  id: row.id,
  events: row.events,
  queue: row.queue,
  filter: jsonOrNull<WebhookFilter>(row.filter),
  shape: jsonOrNull<WebhookShape>(row.shape),
  delayMs: Number(row.delay_ms ?? 0),
  dedupe: jsonOrNull<WebhookDedupe>(row.dedupe),
  from: Number(row.active_from ?? row.created_at),
});

/**
 * What the trigger would make, in its order (event, then webhook), less what a filter drops, with bodies
 * shaped and the due time set by the delay. A de-duplicating webhook's rows carry their key, for `dedupe`.
 */
export function plan(events: readonly JournalEvent[], hooks: readonly Hook[]): Candidate[] {
  const out: Candidate[] = [];
  for (const event of events) {
    const name = JOURNAL_TO_WEBHOOK[event.type];
    if (name === undefined) continue;
    const subject: WebhookSubject = {
      event: name,
      queue: event.queue,
      jobId: event.jobId,
      occurredAt: event.occurredAt,
      state: event.state,
      error: event.error ?? null,
      progress: event.progress ?? null,
    };
    for (const hook of hooks) {
      if (!hook.events.includes(name)) continue;
      if (hook.queue !== null && hook.queue !== event.queue) continue;
      // Never before the webhook was turned on, as with the trigger.
      if (event.occurredAt < hook.from) continue;
      if (hook.filter !== null && !matchesFilter(hook.filter, subject)) continue;
      const rendered = hook.shape === null ? null : renderShape(hook.shape, subject);
      out.push({
        w: hook.id,
        e: event.id,
        n: name,
        q: event.queue,
        j: event.jobId,
        t: event.occurredAt,
        a: event.occurredAt + hook.delayMs,
        k: hook.dedupe === null ? null : keyOf(hook.dedupe, subject),
        u: event.occurredAt + (hook.dedupe?.windowMs ?? 0),
        b: rendered === null ? null : rendered.ok ? rendered.body : '',
        x: rendered !== null && !rendered.ok ? rendered.error : null,
      });
    }
  }
  return out;
}
