import type { Ring } from '@qelay-cloud/core';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import { firstRun, followingRun, sameTiming } from '../cron/schedule';
import type { CronEnvelope, CronRecord, CronSpec } from '../cron/types';
import { spawnedJob, validateCron } from '../cron/validate';
import type { StoreContext } from './context';
import { admitJobs } from './enqueue';
import { identifier, prepareJobs } from './prepare';
import { runTransaction } from './retry';
import { queuesWithWorker } from './workers';

/**
 * Recurring jobs. Adapted from Qelay's `crons.ts` (see docs/PORTING.md). A cron is one row of
 * `qcloud_crons`: `next_run`, `executions` and `max_limit` are columns (the due scan reads them
 * through `qcloud_crons_due_idx`), the rest is the codec-encoded definition.
 *
 * Firing is exactly-once per occurrence without any lock held between ticks: `claimDueCrons`
 * selects due rows `FOR UPDATE SKIP LOCKED`, creates their jobs and advances `next_run` in one
 * transaction. Concurrent callers therefore take disjoint rows, and a caller that dies before
 * commit leaves the occurrence due for the next one.
 */

/** Most crons one `claimDueCrons` fires, when the caller names no other number. */
export const DEFAULT_CRON_LIMIT = 100;

type Time = number | string | bigint;

interface CronRow {
  readonly name: string;
  readonly payload: Uint8Array;
  readonly next_run: Time;
  readonly executions: number;
  readonly max_limit: number | null;
  readonly updated_at: Time;
}

function decode(ctx: StoreContext, row: CronRow): CronRecord {
  const envelope = ctx.codec.decode(row.payload) as CronEnvelope | null;
  if (envelope?.v !== 1) throw new Error(`corrupt cron payload for ${row.name}`);
  const { v: _version, ...definition } = envelope;
  return {
    ...definition,
    name: row.name,
    maxLimit: row.max_limit,
    nextRun: Number(row.next_run),
    executions: row.executions,
    updatedAt: Number(row.updated_at),
  };
}

const envelopeOf = (cron: CronRecord): CronEnvelope => ({
  v: 1,
  queue: cron.queue,
  jobName: cron.jobName,
  data: cron.data,
  schedule: cron.schedule,
  repeatEvery: cron.repeatEvery,
  timezone: cron.timezone,
  priority: cron.priority,
  uniqueKey: cron.uniqueKey,
  dedup: cron.dedup,
  skipIfNoWorker: cron.skipIfNoWorker,
  preventOverlap: cron.preventOverlap,
  jobOptions: cron.jobOptions,
});

/**
 * Creates a cron, or replaces the definition of the one with this name. `executions` is kept. The
 * next run is recomputed from now only when the timing changed: re-upserting an unchanged cron (an
 * application does it on every start) must not push an interval cron's next run back, or a service
 * that restarts more often than the interval would never fire it. `immediately` makes a new cron
 * due at once (the next `claimDueCrons`), not a replaced one.
 */
export async function upsertCron(ctx: StoreContext, spec: CronSpec): Promise<CronRecord> {
  return ctx.db.run('upsertCron', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const valid = validateCron(spec, now);
      // What the dry run can say beyond the options: the data encodes and fits the payload cap.
      prepareJobs(
        [spawnedJob(valid.name, valid.envelope.queue, valid.envelope)],
        ctx.codec,
        ctx.limits
      );
      const [existing] = await tx<CronRow[]>`
        SELECT name, payload, next_run, executions, max_limit, updated_at FROM qcloud_crons
        WHERE namespace = ${ctx.namespace} AND name = ${valid.name}
        FOR UPDATE`;
      const before = existing ? decode(ctx, existing) : null;
      let nextRun: number;
      if (before && sameTiming(before, valid.envelope)) nextRun = before.nextRun;
      else if (!before && valid.immediately) nextRun = now;
      else nextRun = firstRun(valid.envelope, now);
      const executions = before?.executions ?? 0;
      await tx`
        INSERT INTO qcloud_crons (namespace, name, payload, next_run, executions, max_limit, updated_at)
        VALUES (${ctx.namespace}, ${valid.name}, ${ctx.codec.encode(valid.envelope)}, ${nextRun},
                ${executions}, ${valid.maxLimit}, ${now})
        ON CONFLICT (namespace, name) DO UPDATE SET
          payload = excluded.payload, next_run = excluded.next_run,
          executions = excluded.executions, max_limit = excluded.max_limit,
          updated_at = excluded.updated_at`;
      const { v: _version, ...definition } = valid.envelope;
      return {
        ...definition,
        name: valid.name,
        maxLimit: valid.maxLimit,
        nextRun,
        executions,
        updatedAt: now,
      };
    })
  );
}

export async function getCron(ctx: StoreContext, name: string): Promise<CronRecord | null> {
  const key = identifier('name', name);
  return ctx.db.run('getCron', async (sql) => {
    const [row] = await sql<CronRow[]>`
      SELECT name, payload, next_run, executions, max_limit, updated_at FROM qcloud_crons
      WHERE namespace = ${ctx.namespace} AND name = ${key}`;
    return row ? decode(ctx, row) : null;
  });
}

/** Every cron of the namespace, by name. */
export async function listCrons(ctx: StoreContext): Promise<CronRecord[]> {
  return ctx.db.run('listCrons', async (sql) => {
    const rows = await sql<CronRow[]>`
      SELECT name, payload, next_run, executions, max_limit, updated_at FROM qcloud_crons
      WHERE namespace = ${ctx.namespace}
      ORDER BY name`;
    return rows.map((row) => decode(ctx, row));
  });
}

/** Deletes a cron. Jobs it already created stay. False when there was none. */
export async function deleteCron(ctx: StoreContext, name: string): Promise<boolean> {
  const key = identifier('name', name);
  return ctx.db.run('deleteCron', async (sql) => {
    const rows = await sql<Array<{ name: string }>>`
      DELETE FROM qcloud_crons WHERE namespace = ${ctx.namespace} AND name = ${key}
      RETURNING name`;
    return rows.length > 0;
  });
}

export interface CronFiring {
  /** Occurrences that were taken: a job was created, or deduplicated away without `preventOverlap`. */
  readonly fired: number;
  /** Occurrences passed over, uncounted: the previous job was live (`preventOverlap`) or no worker was. */
  readonly skipped: number;
  /** More due crons than the limit were found: another pass has work. */
  readonly more: boolean;
  /** One bell per job created that is claimable now or inside the window, for the caller to publish. */
  readonly rings: readonly Ring[];
}

interface Advance {
  readonly name: string;
  readonly nextRun: number;
  readonly counted: 0 | 1;
  /** No occurrence is left: the cron is closed by setting its limit to its executions. */
  readonly finished: boolean;
}

/**
 * Fires every cron that is due, at most `limit`, in one transaction: the jobs of all of them are
 * admitted in one call (so their locks are taken in the order admission fixes, whatever the crons'
 * order), then each cron's `next_run` and `executions` move. A cron never catches up on missed
 * occurrences; see `followingRun`.
 *
 * A cron whose spawned job is a duplicate is skipped without counting when `preventOverlap` is on
 * (the previous job is still live). With a user key and `preventOverlap` off, a duplicate counts:
 * the occurrence happened, deduplication chose not to make another job.
 */
export async function claimDueCrons(
  ctx: StoreContext,
  limit: number = DEFAULT_CRON_LIMIT
): Promise<CronFiring> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new UnsupportedOptionError('limit', 'must be a positive integer');
  }
  return ctx.db.run('claimDueCrons', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const found = await tx<CronRow[]>`
        SELECT name, payload, next_run, executions, max_limit, updated_at FROM qcloud_crons
        WHERE namespace = ${ctx.namespace} AND next_run <= ${now}
          AND (max_limit IS NULL OR executions < max_limit)
        ORDER BY next_run, name
        LIMIT ${limit + 1}
        FOR UPDATE SKIP LOCKED`;
      const due = found.slice(0, limit).map((row) => ({ row, cron: decode(ctx, row) }));
      const more = found.length > limit;
      if (due.length === 0) return { fired: 0, skipped: 0, more, rings: [] };

      const served = await queuesWithWorker(
        tx,
        ctx,
        due.filter(({ cron }) => cron.skipIfNoWorker).map(({ cron }) => cron.queue),
        now
      );
      const firing = due.filter(({ cron }) => !cron.skipIfNoWorker || served.has(cron.queue));
      const outcomes = await admitJobs(
        ctx,
        tx,
        prepareJobs(
          firing.map(({ cron }) => spawnedJob(cron.name, cron.queue, envelopeOf(cron))),
          ctx.codec,
          ctx.limits
        )
      );

      const created = new Map<string, boolean>();
      const rings: Ring[] = [];
      firing.forEach(({ cron }, index) => {
        const outcome = outcomes[index]!;
        created.set(cron.name, outcome.created);
        if (outcome.ring) rings.push(outcome.ring);
      });
      const advances = due.map(({ cron }): Advance => {
        const ran = created.get(cron.name);
        const counted = ran === undefined || (!ran && cron.preventOverlap) ? 0 : 1;
        const nextRun = followingRun(cron, cron.nextRun, now);
        return { name: cron.name, nextRun, counted, finished: nextRun === 0 };
      });
      await advance(tx, ctx, advances, now);
      const fired = advances.filter((step) => step.counted === 1).length;
      return { fired, skipped: advances.length - fired, more, rings };
    })
  );
}

async function advance(
  tx: TransactionSQL,
  ctx: StoreContext,
  steps: readonly Advance[],
  now: number
): Promise<void> {
  // `counted` first, so a finished cron's limit is the executions after this occurrence.
  await tx`
    UPDATE qcloud_crons cron
    SET executions = cron.executions + step.counted,
        next_run = CASE WHEN step.finished THEN cron.next_run ELSE step.next_run END,
        max_limit = CASE WHEN step.finished THEN cron.executions + step.counted ELSE cron.max_limit END,
        updated_at = ${now}
    FROM unnest(${tx.array(
      steps.map((step) => step.name),
      'TEXT'
    )}, ${tx.array(
      steps.map((step) => step.nextRun),
      'BIGINT'
    )}, ${tx.array(
      steps.map((step) => step.counted),
      'INTEGER'
    )}, ${tx.array(
      steps.map((step) => step.finished),
      'BOOLEAN'
    )}) AS step(name, next_run, counted, finished)
    WHERE cron.namespace = ${ctx.namespace} AND cron.name = step.name`;
}
