import {
  UnsupportedOptionError,
  validateBatch,
  validateDedupe,
  validateDelay,
  validateDescription,
  validateFilter,
  validateName,
  validateShape,
} from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { identifier } from './prepare';
import { runTransaction } from './retry';
import type { WebhookRow } from './webhookRows';
import { WEBHOOK_COLUMNS, webhookOf } from './webhookRows';
import type { WebhookPatch, WebhookRecord } from './webhookTypes';
import { checkedSchedule } from './webhookValidate';

const FIELDS = [
  'name',
  'description',
  'source',
  'filter',
  'shape',
  'delayMs',
  'dedupe',
  'schedule',
  'batch',
] as const;

const json = (value: object | null): string | null =>
  value === null ? null : JSON.stringify(value);

/**
 * The patch's own fields, checked, by key; a field that is not present is not in it. A batch is kept as given: it is
 * checked in the transaction, against the destination of the route it lands on.
 */
function checked(patch: WebhookPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const has = (key: (typeof FIELDS)[number]) => patch[key] !== undefined;
  if (FIELDS.every((key) => !has(key))) {
    throw new UnsupportedOptionError('patch', 'name at least one field to change');
  }
  if (has('name')) out.name = validateName(patch.name);
  if (has('description')) out.description = validateDescription(patch.description);
  if (has('source')) out.source = identifier('source', patch.source);
  if (has('filter')) out.filter = patch.filter === null ? null : validateFilter(patch.filter);
  if (has('shape')) out.shape = patch.shape === null ? null : validateShape(patch.shape);
  if (has('delayMs')) out.delayMs = validateDelay(patch.delayMs);
  if (has('dedupe')) out.dedupe = validateDedupe(patch.dedupe);
  if (has('schedule')) out.schedule = checkedSchedule(patch.schedule);
  if (has('batch')) out.batch = patch.batch;
  return out;
}

/**
 * Changes a webhook's name, description, source and rules (`WebhookPatch`), leaving every other field as it is.
 * Refused, with nothing written, for an empty patch, a value that does not validate or a source that does not exist
 * (`UnsupportedOptionError`, naming the option). A change applies to requests taken from now: deliveries already made keep
 * what they were made with. Null when there is no such webhook.
 */
export async function updateWebhook(
  ctx: StoreContext,
  id: string,
  patch: WebhookPatch
): Promise<WebhookRecord | null> {
  const key = identifier('id', id);
  const set = checked(patch);
  return ctx.db.run('updateWebhook', (sql) =>
    runTransaction(sql, async (tx) => {
      const [current] = await tx.unsafe<WebhookRow[]>(
        `SELECT ${WEBHOOK_COLUMNS} FROM qcloud_webhooks
         WHERE namespace = $1 AND id = $2 FOR NO KEY UPDATE`,
        [ctx.namespace, key]
      );
      if (!current) return null;
      const now = webhookOf(current);
      if ('source' in set) {
        // KEY SHARE: a delete of the source in flight finishes first, and we see it gone.
        const [found] = await tx<Array<{ id: string }>>`
          SELECT id FROM qcloud_sources
          WHERE namespace = ${ctx.namespace} AND id = ${set.source as string} FOR KEY SHARE`;
        if (!found) throw new UnsupportedOptionError('source', 'no such source');
      }
      const next = {
        name: 'name' in set ? (set.name as string | null) : now.name,
        description: 'description' in set ? (set.description as string | null) : now.description,
        source: 'source' in set ? (set.source as string) : now.source,
        filter: 'filter' in set ? (set.filter as WebhookRecord['filter']) : now.filter,
        shape: 'shape' in set ? (set.shape as WebhookRecord['shape']) : now.shape,
        delayMs: 'delayMs' in set ? (set.delayMs as number | null) : now.delayMs,
        dedupe: 'dedupe' in set ? (set.dedupe as WebhookRecord['dedupe']) : now.dedupe,
        schedule: 'schedule' in set ? (set.schedule as WebhookRecord['schedule']) : now.schedule,
        batch: 'batch' in set ? validateBatch(set.batch, now.destination) : now.batch,
      };
      const [row] = await tx.unsafe<WebhookRow[]>(
        `UPDATE qcloud_webhooks
         SET name = $3, description = $4, filter = $5::text::jsonb, shape = $6::text::jsonb,
             delay_ms = $7, dedupe = $8::text::jsonb, source_id = $9,
             schedule_cron = $10, schedule_timezone = $11, batch_max_events = $12, batch_max_bytes = $13
         WHERE namespace = $1 AND id = $2
         RETURNING ${WEBHOOK_COLUMNS}`,
        [
          ctx.namespace,
          key,
          next.name,
          next.description,
          json(next.filter),
          json(next.shape),
          next.delayMs,
          json(next.dedupe),
          next.source,
          next.schedule?.cron ?? null,
          next.schedule?.timezone ?? null,
          next.batch?.maxEvents ?? null,
          next.batch?.maxBytes ?? null,
        ]
      );
      return webhookOf(row!);
    })
  );
}
