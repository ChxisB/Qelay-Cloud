import type { ClaimedJob, JobOptions } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import { createMsgpackCodec } from '../src/codec';
import type { PostgresStore } from '../src/postgresStore';
import type { EventRecorder, StoreEvent } from '../src/store/events';
import type { DlqBlob, RetryState } from '../src/store/retryState';
import type { TestStore } from './storeHelpers';
import { enqueueN, rewind } from './storeHelpers';

export const codec = createMsgpackCodec();

export interface JobRow {
  state: string;
  attempts: number;
  max_attempts: number;
  run_at: string;
  rung_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_until: string | null;
  lease_renewals: number;
  error: string | null;
  failure_reason: string | null;
  result: Uint8Array | null;
  dlq_entry: Uint8Array | null;
  dlq_retry_state: Uint8Array | null;
  version: string;
}

export const readJob = async (t: TestStore, id: string): Promise<JobRow | undefined> =>
  (await t.fresh.sql<JobRow[]>`SELECT * FROM qcloud_jobs WHERE id = ${id}`)[0];

export const blobOf = (row: JobRow | undefined): DlqBlob =>
  codec.decode(row!.dlq_entry!) as DlqBlob;
export const retryStateOf = (row: JobRow | undefined): RetryState =>
  codec.decode(row!.dlq_retry_state!) as RetryState;

/** Empties every table the store's operations write, and puts the clock back at `START`. */
export async function resetTables(t: TestStore): Promise<void> {
  await t.fresh.sql`TRUNCATE qcloud_jobs, qcloud_queue_state, qcloud_completions,
    qcloud_metric_buckets, qcloud_metric_totals, qcloud_job_logs, qcloud_dependencies,
    qcloud_flow_failures, qcloud_events, qcloud_event_commits, qcloud_event_prune_watermarks,
    qcloud_event_retention_state, qcloud_event_retention_deltas, qcloud_group_state, qcloud_crons,
    qcloud_workers, qcloud_audit, qcloud_webhooks, qcloud_webhook_destinations, qcloud_webhook_dedupe, qcloud_webhook_issues, qcloud_webhook_writers, qcloud_deliveries, qcloud_webhook_deliveries,
    qcloud_workflow_executions, qcloud_workflow_executions_archive, qcloud_workflow_definitions`;
  rewind(t);
}

/** Enqueues one job and claims it, so the caller holds its lease. */
export async function claimOne(
  t: Pick<TestStore, 'store'>,
  options: JobOptions = {},
  queue = 'q',
  worker = 'w'
): Promise<ClaimedJob> {
  await enqueueN(t.store, 1, options, queue);
  return (await t.store.claim(queue, worker, 1))[0]!;
}

/**
 * Writes the queue's stall and DLQ configuration blobs as given, bypassing the setters, so a test
 * can store what they would refuse (a corrupt or out-of-range value the readers must survive).
 */
export async function configureQueue(
  t: TestStore,
  queue: string,
  config: { stall?: unknown; dlq?: unknown }
): Promise<void> {
  const stall = config.stall === undefined ? null : codec.encode(config.stall);
  const dlq = config.dlq === undefined ? null : codec.encode(config.dlq);
  await t.fresh.sql`
    INSERT INTO qcloud_queue_state (namespace, queue, stall_config, dlq_config)
    VALUES ('test', ${queue}, ${stall}, ${dlq})
    ON CONFLICT (namespace, queue) DO UPDATE SET
      stall_config = excluded.stall_config, dlq_config = excluded.dlq_config`;
}

export async function metric(
  t: TestStore,
  queue: string,
  type: 'completed' | 'failed'
): Promise<{ total: number; buckets: Array<{ minute: number; count: number }> }> {
  const totals = await t.fresh.sql<{ total_count: string }[]>`
    SELECT total_count FROM qcloud_metric_totals
    WHERE namespace = 'test' AND queue = ${queue} AND metric_type = ${type}`;
  const buckets = await t.fresh.sql<{ minute: string; count: number }[]>`
    SELECT minute, count FROM qcloud_metric_buckets
    WHERE namespace = 'test' AND queue = ${queue} AND metric_type = ${type} ORDER BY minute`;
  return {
    total: totals[0] ? Number(totals[0].total_count) : 0,
    buckets: buckets.map((row) => ({ minute: Number(row.minute), count: row.count })),
  };
}

/** An event recorder that keeps what it is given, and can be told to throw. */
export function recording(): {
  recorder: EventRecorder;
  events: StoreEvent[];
  failWith(error: Error | null): void;
} {
  const events: StoreEvent[] = [];
  let failure: Error | null = null;
  return {
    events,
    failWith: (error) => {
      failure = error;
    },
    recorder: {
      record: async (_tx: TransactionSQL, batch) => {
        if (failure) throw failure;
        events.push(...batch);
      },
    },
  };
}

/** Moves the clock past a job's lease, so recovery can take it. */
export const expireLease = (t: TestStore, job: ClaimedJob, extraMs = 0): void =>
  t.clock.advance(job.leaseUntil - t.clock.now() + extraMs);

/**
 * Completes `count` jobs of `queue` with `removeOnComplete`, so each leaves a completion record and
 * no job row, a millisecond apart so the records have distinct times. Returns their ids, oldest first.
 */
export async function completeAndRemove(
  t: TestStore,
  count: number,
  queue = 'q',
  store: PostgresStore = t.store
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    await enqueueN(store, 1, { removeOnComplete: true }, queue);
    const [job] = await store.claim(queue, 'w', 1);
    await store.complete(job!.lease, 'ok');
    ids.push(job!.id);
    t.clock.advance(1);
  }
  return ids;
}

/** Inserts group-state rows with the given columns, defaulting to a row with nothing but a position. */
export async function insertGroup(
  t: TestStore,
  groupId: string,
  columns: Record<string, number | boolean | null> = {},
  options: { queue?: string; namespace?: string } = {}
): Promise<void> {
  const row = { last_served: 1, ...columns };
  const names = Object.keys(row);
  await t.fresh.sql.unsafe(
    `INSERT INTO qcloud_group_state (namespace, queue, group_id, ${names.join(', ')})
     VALUES ($1, $2, $3, ${names.map((_, index) => `$${index + 4}`).join(', ')})`,
    [options.namespace ?? 'test', options.queue ?? 'q', groupId, ...Object.values(row)]
  );
}
