import type { Planned } from './schema.planned';

/**
 * The query paths of webhooks (task 52). The statements are written out here as the store runs them
 * (`webhookClaim.ts`, `webhookRecord.ts`, `webhookRetention.ts`, `webhooks.ts`), with the values the
 * store binds filled in; a change to one of them is a change to its row. The webhook registry itself
 * is capped at 100 rows per namespace, so reading it needs no index beyond the primary key.
 */
export const PLANNED_WEBHOOK: readonly Planned[] = [
  {
    query: 'webhook claim: does a webhook have a delivery due',
    sql: `SELECT w.id FROM qcloud_webhooks w
          WHERE w.namespace = 'ns' AND w.enabled
            AND EXISTS (
              SELECT 1 FROM qcloud_webhook_deliveries d
              WHERE d.namespace = 'ns' AND d.webhook_id = w.id
                AND d.status IN ('pending', 'sending') AND d.next_attempt_at <= 4000000)
          ORDER BY w.last_triggered NULLS FIRST, w.id LIMIT 50`,
    index: 'qcloud_webhook_deliveries_due_idx',
  },
  {
    query: "webhook claim: one webhook's due deliveries, oldest first",
    sql: `SELECT x.id FROM qcloud_webhook_deliveries x
          WHERE x.namespace = 'ns' AND x.webhook_id = 'w3'
            AND x.status IN ('pending', 'sending') AND x.next_attempt_at <= 4000000
          ORDER BY x.next_attempt_at, x.id LIMIT 20`,
    index: 'qcloud_webhook_deliveries_due_idx',
    ordered: true,
  },
  {
    query: 'webhook record: the delivery an outcome is about',
    sql: `SELECT id, attempts, attempt_base, history FROM qcloud_webhook_deliveries
          WHERE namespace = 'ns' AND id = ANY(ARRAY[11, 12, 13]::bigint[]) AND status = 'sending'
          ORDER BY id`,
    index: 'qcloud_webhook_deliveries_pkey',
  },
  {
    query: "webhook history: a webhook's deliveries, newest first, a page at a time",
    sql: `SELECT id FROM qcloud_webhook_deliveries
          WHERE namespace = 'ns' AND webhook_id = 'w3'
            AND (NULL::bigint IS NULL OR id < NULL::bigint)
            AND (NULL::text IS NULL OR status = NULL::text)
          ORDER BY id DESC LIMIT 51`,
    index: 'qcloud_webhook_deliveries_history_idx',
    ordered: true,
  },
  {
    query: 'webhook history: the failed ones of a webhook, newest first',
    sql: `SELECT id FROM qcloud_webhook_deliveries
          WHERE namespace = 'ns' AND webhook_id = 'w3' AND id < 7000 AND status = 'failed'
          ORDER BY id DESC LIMIT 51`,
    index: 'qcloud_webhook_deliveries_history_idx',
    ordered: true,
  },
  {
    query: 'webhook retry: a delivery of a webhook by id',
    sql: `SELECT status FROM qcloud_webhook_deliveries
          WHERE namespace = 'ns' AND webhook_id = 'w3' AND id = 43`,
    // Both are a point lookup: the key by id alone, or the history index by webhook and id.
    index: 'qcloud_webhook_deliveries_pkey',
    alternatives: ['qcloud_webhook_deliveries_history_idx'],
  },
  {
    query: 'webhook trigger: the delivery an event already has for a webhook',
    sql: `SELECT id FROM qcloud_webhook_deliveries
          WHERE namespace = 'ns' AND webhook_id = 'w3' AND event_id = 43`,
    index: 'qcloud_webhook_deliveries_event_idx',
  },
  {
    query: 'webhook retention: does a webhook have a delivery past its expiry',
    sql: `SELECT w.id FROM qcloud_webhooks w
          WHERE w.namespace = 'ns'
            AND EXISTS (
              SELECT 1 FROM qcloud_webhook_deliveries d
              WHERE d.namespace = 'ns' AND d.webhook_id = w.id
                AND d.status IN ('pending', 'sending') AND d.next_attempt_at < 1000000)
          ORDER BY w.id`,
    index: 'qcloud_webhook_deliveries_due_idx',
  },
  {
    query: 'webhook retention: the expired deliveries of those webhooks, oldest first',
    sql: `SELECT x.id FROM qcloud_webhook_deliveries x
          WHERE x.namespace = 'ns' AND x.webhook_id = ANY(ARRAY['w3', 'w4']::text[])
            AND x.status IN ('pending', 'sending') AND x.next_attempt_at < 1000000
          ORDER BY x.next_attempt_at LIMIT 500`,
    index: 'qcloud_webhook_deliveries_stale_idx',
    alternatives: ['qcloud_webhook_deliveries_due_idx'],
  },
  {
    query: 'webhook retention: finished deliveries past their keep, oldest first',
    sql: `SELECT id FROM qcloud_webhook_deliveries
          WHERE namespace = 'ns' AND status IN ('delivered', 'failed') AND finished_at < 1000000
          ORDER BY finished_at LIMIT 500`,
    index: 'qcloud_webhook_deliveries_finished_idx',
    ordered: true,
  },
];
