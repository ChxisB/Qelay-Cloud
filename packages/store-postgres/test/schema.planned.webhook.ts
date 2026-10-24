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
              SELECT 1 FROM qcloud_deliveries d
              WHERE d.namespace = 'ns' AND d.webhook_id = w.id
                AND d.status IN ('pending', 'sending') AND d.next_attempt_at <= 4000000)
          ORDER BY w.last_triggered NULLS FIRST, w.id LIMIT 50`,
    index: 'qcloud_deliveries_due_idx',
  },
  {
    query: "webhook claim: one webhook's due deliveries, oldest first",
    sql: `SELECT x.id FROM qcloud_deliveries x
          WHERE x.namespace = 'ns' AND x.webhook_id = 'w3'
            AND x.status IN ('pending', 'sending') AND x.next_attempt_at <= 4000000
          ORDER BY x.next_attempt_at, x.id LIMIT 20`,
    index: 'qcloud_deliveries_due_idx',
    ordered: true,
  },
  {
    query: 'webhook record: the delivery an outcome is about',
    sql: `SELECT id, attempts, attempt_base, history FROM qcloud_deliveries
          WHERE namespace = 'ns' AND id = ANY(ARRAY[11, 12, 13]::bigint[]) AND status = 'sending'
          ORDER BY id`,
    index: 'qcloud_deliveries_pkey',
  },
  {
    query: "webhook history: a webhook's deliveries, newest first, a page at a time",
    sql: `SELECT id FROM qcloud_deliveries
          WHERE namespace = 'ns' AND webhook_id = 'w3'
            AND (NULL::bigint IS NULL OR id < NULL::bigint)
            AND (NULL::text IS NULL OR status = NULL::text)
          ORDER BY id DESC LIMIT 51`,
    index: 'qcloud_deliveries_history_idx',
    ordered: true,
  },
  {
    query: 'webhook history: the failed ones of a webhook, newest first',
    sql: `SELECT id FROM qcloud_deliveries
          WHERE namespace = 'ns' AND webhook_id = 'w3' AND id < 7000 AND status = 'failed'
          ORDER BY id DESC LIMIT 51`,
    index: 'qcloud_deliveries_history_idx',
    ordered: true,
  },
  {
    query: "webhook feed: every webhook's deliveries, newest first, a page at a time",
    sql: `SELECT id FROM qcloud_deliveries
          WHERE namespace = 'ns' AND id < 7000 AND status = 'failed'
          ORDER BY id DESC LIMIT 51`,
    index: 'qcloud_deliveries_pkey',
    ordered: true,
  },
  {
    query:
      "webhook feed: every webhook's deliveries in a time window, newest first (the Events default)",
    sql: `SELECT id FROM qcloud_deliveries
          WHERE namespace = 'ns' AND created_at >= 1000000 AND created_at < 9000000
          ORDER BY id DESC LIMIT 51`,
    index: 'qcloud_deliveries_pkey',
    ordered: true,
  },
  {
    query: "webhook feed: one webhook's deliveries in a time window, newest first",
    sql: `SELECT id FROM qcloud_deliveries
          WHERE namespace = 'ns' AND webhook_id = 'w3' AND created_at >= 1000000 AND created_at < 9000000
          ORDER BY id DESC LIMIT 51`,
    index: 'qcloud_deliveries_history_idx',
    ordered: true,
  },
  {
    query: 'webhook bulk retry: the failed deliveries of a webhook to put back, newest first',
    sql: `SELECT id FROM qcloud_deliveries
          WHERE namespace = 'ns' AND webhook_id = 'w3' AND status = 'failed' AND id < 7000
          ORDER BY id DESC LIMIT 500 FOR UPDATE SKIP LOCKED`,
    index: 'qcloud_deliveries_history_idx',
    ordered: true,
  },
  {
    query: 'webhook stats: the deliveries of a window, counted by outcome',
    sql: `SELECT (created_at - 1000000) / 60000 AS bucket, status, count(*), sum(attempts)
          FROM qcloud_deliveries
          WHERE namespace = 'ns' AND created_at >= 1000000 AND created_at < 9000000
          GROUP BY 1, 2`,
    index: 'qcloud_deliveries_history_idx',
    alternatives: ['qcloud_deliveries_stale_idx', 'qcloud_deliveries_default_created_idx'],
  },
  {
    query: 'webhook stats by webhook: the deliveries of a window, counted by webhook and outcome',
    sql: `SELECT webhook_id, (created_at - 1000000) / 60000 AS bucket, status, count(*)
          FROM qcloud_deliveries
          WHERE namespace = 'ns' AND created_at >= 1000000 AND created_at < 9000000
          GROUP BY 1, 2, 3`,
    index: 'qcloud_deliveries_history_idx',
    alternatives: ['qcloud_deliveries_stale_idx', 'qcloud_deliveries_default_created_idx'],
  },
  {
    query: 'webhook stats: what is waiting or being sent now, and the oldest',
    sql: `SELECT sum(p.n), min(p.oldest)
          FROM qcloud_webhooks w CROSS JOIN LATERAL (
            SELECT count(*) AS n, min(d.created_at) AS oldest FROM qcloud_deliveries d
            WHERE d.namespace = w.namespace AND d.webhook_id = w.id AND d.status IN ('pending', 'sending')) p
          WHERE w.namespace = 'ns'`,
    index: 'qcloud_deliveries_due_idx',
  },
  {
    query: "webhook stats: the attempts in a window, from the deliveries' history",
    sql: `SELECT (a.at - 1000000) / 60000 AS bucket, avg(a.ms)
          FROM (SELECT (e ->> 'at')::bigint AS at, (e ->> 'durationMs')::bigint AS ms
                FROM qcloud_deliveries x CROSS JOIN LATERAL jsonb_array_elements(x.history) e
                WHERE x.namespace = 'ns' AND x.created_at >= 1000000 AND x.created_at < 9000000
                  AND e ->> 'statusCode' IS NOT NULL) a
          GROUP BY ROLLUP (1)`,
    index: 'qcloud_deliveries_history_idx',
    alternatives: ['qcloud_deliveries_stale_idx', 'qcloud_deliveries_default_created_idx'],
  },
  {
    query: 'webhook retry: a delivery of a webhook by id',
    sql: `SELECT status FROM qcloud_deliveries
          WHERE namespace = 'ns' AND webhook_id = 'w3' AND id = 43`,
    // Both are a point lookup: the key by id alone, or the history index by webhook and id.
    index: 'qcloud_deliveries_pkey',
    alternatives: ['qcloud_deliveries_history_idx'],
  },
  {
    query: "webhook dedupe: a key's window (the arbiter of the accept's upsert)",
    sql: `SELECT d.webhook_id, d.key, d.until FROM qcloud_webhook_dedupe d
          WHERE d.namespace = 'ns' AND d.webhook_id = 'w' AND d.key = 'k'`,
    index: 'qcloud_webhook_dedupe_pkey',
  },
  {
    query: 'webhook dedupe: the keys whose window has ended, oldest first (the tick prunes them)',
    sql: `SELECT namespace, webhook_id, key FROM qcloud_webhook_dedupe
          WHERE namespace = 'ns' AND until <= 4000000 ORDER BY until LIMIT 500`,
    index: 'qcloud_webhook_dedupe_until_idx',
    ordered: true,
  },
  {
    query: 'webhook issues: one status, newest first, a page at a time (the Issues screen)',
    sql: `SELECT id FROM qcloud_webhook_issues
          WHERE namespace = 'ns' AND status = 'open'
            AND ('w3'::text IS NULL OR webhook_id = 'w3'::text)
            AND (NULL::bigint IS NULL OR id < NULL::bigint)
          ORDER BY id DESC LIMIT 51`,
    index: 'qcloud_webhook_issues_status_idx',
    ordered: true,
  },
  {
    query: 'webhook issues: how many of each status',
    sql: `SELECT status, count(*)::int FROM qcloud_webhook_issues WHERE namespace = 'ns' GROUP BY status`,
    index: 'qcloud_webhook_issues_status_idx',
  },
  {
    query: 'webhook issues: the issue an operator sets the status of',
    sql: `SELECT id FROM qcloud_webhook_issues WHERE namespace = 'ns' AND id = 43 AND status <> 'resolved'`,
    index: 'qcloud_webhook_issues_pkey',
  },
  {
    query: 'webhook issues: the live issues a delivery resolves (the record path)',
    sql: `SELECT id FROM qcloud_webhook_issues
          WHERE namespace = 'ns' AND webhook_id = ANY(ARRAY['w3', 'w4']::text[])
            AND status IN ('open', 'acknowledged', 'ignored')`,
    index: 'qcloud_webhook_issues_live_idx',
  },
  {
    query: 'webhook issues: the routes a failed delivery opens an issue for (the record path)',
    sql: `SELECT w.id FROM qcloud_webhooks w
          WHERE w.namespace = 'ns' AND w.id = ANY(ARRAY['w3', 'w4']::text[])
            AND w.disabled_reason IS DISTINCT FROM 'paused by an operator'`,
    index: 'qcloud_webhooks_pkey',
  },
  {
    query: 'webhook issues: resolved ones past their keep, oldest first (the tick prunes them)',
    sql: `SELECT id FROM qcloud_webhook_issues
          WHERE namespace = 'ns' AND status = 'resolved' AND updated_at < 1000000
          ORDER BY updated_at LIMIT 500`,
    index: 'qcloud_webhook_issues_resolved_idx',
    ordered: true,
  },
  {
    query: 'destinations: is the name taken (a save checks it under the namespace lock)',
    sql: `SELECT id FROM qcloud_webhook_destinations
          WHERE namespace = 'ns' AND name = 'Billing' AND id IS DISTINCT FROM 'd1'`,
    index: 'qcloud_webhook_destinations_name_idx',
  },
  {
    query:
      'destinations: the webhooks made from one (the in-use check, and the rewrite of their address)',
    sql: `SELECT count(*) FROM qcloud_webhooks WHERE namespace = 'ns' AND destination_id = 'd1'`,
    index: 'qcloud_webhooks_destination_idx',
  },
  {
    query: 'destinations: the list, with how many webhooks use each',
    sql: `SELECT d.id, (SELECT count(*) FROM qcloud_webhooks w
                        WHERE w.namespace = d.namespace AND w.destination_id = d.id) AS connections
          FROM qcloud_webhook_destinations d WHERE d.namespace = 'ns' ORDER BY d.created_at, d.id`,
    index: 'qcloud_webhooks_destination_idx',
  },
  {
    query: 'webhook retention: does a webhook have a delivery past its expiry',
    sql: `SELECT w.id FROM qcloud_webhooks w
          WHERE w.namespace = 'ns'
            AND EXISTS (
              SELECT 1 FROM qcloud_deliveries d
              WHERE d.namespace = 'ns' AND d.webhook_id = w.id
                AND d.status IN ('pending', 'sending') AND d.next_attempt_at < 1000000)
          ORDER BY w.id`,
    index: 'qcloud_deliveries_due_idx',
  },
  {
    query: 'webhook retention: the expired deliveries of those webhooks, oldest first',
    sql: `SELECT x.id FROM qcloud_deliveries x
          WHERE x.namespace = 'ns' AND x.webhook_id = ANY(ARRAY['w3', 'w4']::text[])
            AND x.status IN ('pending', 'sending') AND x.next_attempt_at < 1000000
          ORDER BY x.next_attempt_at LIMIT 500`,
    index: 'qcloud_deliveries_stale_idx',
    alternatives: ['qcloud_deliveries_due_idx'],
  },
  {
    query:
      'webhook retention: finished deliveries of the default partition past their keep, oldest first',
    sql: `SELECT id FROM qcloud_deliveries_default
          WHERE namespace = 'ns' AND status IN ('delivered', 'failed') AND finished_at < 1000000
          ORDER BY finished_at LIMIT 500`,
    index: 'qcloud_deliveries_default_finished_idx',
    ordered: true,
  },
  {
    query: 'webhook partitions: whether a day without a partition has rows in the default one',
    sql: `SELECT 1 FROM qcloud_deliveries_default WHERE created_at >= 1000000 AND created_at < 87400000`,
    index: 'qcloud_deliveries_default_created_idx',
  },
];
