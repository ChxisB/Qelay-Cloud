import {
  UnsupportedOptionError,
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
import { checkEvents, needsWriter } from './webhookValidate';

const FIELDS = ['name', 'description', 'events', 'filter', 'shape', 'delayMs', 'dedupe'] as const;

const json = (value: object | null): string | null =>
  value === null ? null : JSON.stringify(value);

/** The patch's own fields, checked, by key; a field that is not present is not in it. */
function checked(patch: WebhookPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const has = (key: (typeof FIELDS)[number]) => patch[key] !== undefined;
  if (FIELDS.every((key) => !has(key))) {
    throw new UnsupportedOptionError('patch', 'name at least one field to change');
  }
  if (has('name')) out.name = validateName(patch.name);
  if (has('description')) out.description = validateDescription(patch.description);
  if (has('events')) out.events = checkEvents(patch.events);
  if (has('filter')) out.filter = patch.filter === null ? null : validateFilter(patch.filter);
  if (has('shape')) out.shape = patch.shape === null ? null : validateShape(patch.shape);
  if (has('delayMs')) out.delayMs = validateDelay(patch.delayMs);
  if (has('dedupe')) out.dedupe = validateDedupe(patch.dedupe);
  return out;
}

/**
 * Changes a webhook's name, description, events and rules (`WebhookPatch`), leaving every other field as it is. Refused, with
 * nothing written, for an empty patch or a value that does not validate (`UnsupportedOptionError`, naming the option), and
 * for a rule only the writer applies when the namespace has none on, as at creation. A change applies to events made from
 * now: deliveries already made keep what they were made with. Null when there is no such webhook.
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
      const next = {
        name: 'name' in set ? (set.name as string | null) : now.name,
        description: 'description' in set ? (set.description as string | null) : now.description,
        events: 'events' in set ? (set.events as string[]) : [...now.events],
        filter: 'filter' in set ? (set.filter as WebhookRecord['filter']) : now.filter,
        shape: 'shape' in set ? (set.shape as WebhookRecord['shape']) : now.shape,
        delayMs: 'delayMs' in set ? (set.delayMs as number | null) : now.delayMs,
        dedupe: 'dedupe' in set ? (set.dedupe as WebhookRecord['dedupe']) : now.dedupe,
      };
      const added = needsWriter({
        filter: 'filter' in set ? next.filter : null,
        shape: 'shape' in set ? next.shape : null,
        delayMs: 'delayMs' in set ? next.delayMs : null,
        dedupe: 'dedupe' in set ? next.dedupe : null,
      });
      if (added !== null) {
        // KEY SHARE: switching the writer off waits for this transaction, then sees the rule.
        const [writer] = await tx<Array<{ namespace: string }>>`
          SELECT namespace FROM qcloud_webhook_writers
          WHERE namespace = ${ctx.namespace} AND NOT stopping FOR KEY SHARE`;
        if (!writer) {
          throw new UnsupportedOptionError(
            added,
            'needs the webhook delivery writer: switch it on first (qcloud-tick webhook-writer on)'
          );
        }
      }
      const [row] = await tx.unsafe<WebhookRow[]>(
        `UPDATE qcloud_webhooks
         SET name = $3, description = $4,
             events = ARRAY(SELECT jsonb_array_elements_text($5::text::jsonb)), filter = $6::text::jsonb,
             shape = $7::text::jsonb, delay_ms = $8, dedupe = $9::text::jsonb
         WHERE namespace = $1 AND id = $2
         RETURNING ${WEBHOOK_COLUMNS}`,
        [
          ctx.namespace,
          key,
          next.name,
          next.description,
          JSON.stringify(next.events),
          json(next.filter),
          json(next.shape),
          next.delayMs,
          json(next.dedupe),
        ]
      );
      return webhookOf(row!);
    })
  );
}
