import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { identifier } from './prepare';
import { JOB_LOGS } from './readQueries';
import { runTransaction } from './retry';

/**
 * Per-job log lines, as `job.log()` of a worker writes them and the panel shows them. Adapted from
 * Qelay's `logs.ts` (see docs/PORTING.md). A job keeps at most `maxJobLogs` lines: adding one past it
 * deletes the oldest, in the same transaction. The job row is locked while a line is added, so the
 * cap holds under concurrent writers and a line is never added for a job that is gone. The lines go
 * with the job (`deleteJobRows`).
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface JobLogEntry {
  readonly timestamp: number;
  readonly level: LogLevel;
  readonly message: string;
}

export const DEFAULT_MAX_JOB_LOGS = 100;
export const MAX_JOB_LOGS = 1_000;
/** Longest line, in characters. A longer one is refused, not cut: a log that lost its end misleads. */
export const MAX_LOG_MESSAGE_CHARS = 16_384;

const LEVELS: readonly string[] = ['info', 'warn', 'error'];

/** The lines to delete: all but the newest `keep`. Parameters: namespace, job id, keep. */
export const TRIM_JOB_LOGS = `
  DELETE FROM qcloud_job_logs
  WHERE namespace = $1 AND job_id = $2
    AND id <= (
      SELECT id FROM qcloud_job_logs
      WHERE namespace = $1 AND job_id = $2
      ORDER BY id DESC OFFSET $3 LIMIT 1
    )
  RETURNING id`;

function checkedMessage(message: unknown): string {
  if (typeof message !== 'string' || message === '' || message.includes('\0')) {
    throw new UnsupportedOptionError('message', 'must be a non-empty string without NUL');
  }
  if (message.length > MAX_LOG_MESSAGE_CHARS) {
    throw new UnsupportedOptionError(
      'message',
      `must be at most ${MAX_LOG_MESSAGE_CHARS} characters`
    );
  }
  return message;
}

/** False when the job does not exist (it finished and was removed, or never was). */
export async function addJobLog(
  ctx: StoreContext,
  jobId: string,
  message: string,
  level: LogLevel = 'info'
): Promise<boolean> {
  const id = identifier('jobId', jobId);
  const line = checkedMessage(message);
  if (!LEVELS.includes(level)) {
    throw new UnsupportedOptionError('level', 'must be info, warn or error');
  }
  return ctx.db.run('addJobLog', (sql) =>
    runTransaction(sql, async (tx) => {
      const jobs = await tx`
        SELECT id FROM qcloud_jobs WHERE namespace = ${ctx.namespace} AND id = ${id} FOR UPDATE`;
      if (jobs.length === 0) return false;
      const now = await ctx.db.time.now(tx);
      await tx`
        INSERT INTO qcloud_job_logs (namespace, job_id, timestamp, level, message)
        VALUES (${ctx.namespace}, ${id}, ${now}, ${level}, ${line})`;
      await tx.unsafe(TRIM_JOB_LOGS, [ctx.namespace, id, ctx.maxJobLogs]);
      return true;
    })
  );
}

/** A job's lines, oldest first: at most `MAX_JOB_LOGS`, which the cap keeps them under. */
export async function listJobLogs(ctx: StoreContext, jobId: string): Promise<JobLogEntry[]> {
  const id = identifier('jobId', jobId);
  const rows = await ctx.db.run('listJobLogs', (sql) =>
    sql.unsafe<Array<{ timestamp: number | string | bigint; level: LogLevel; message: string }>>(
      JOB_LOGS,
      [ctx.namespace, id, MAX_JOB_LOGS]
    )
  );
  return rows.map((row) => ({
    timestamp: Number(row.timestamp),
    level: row.level,
    message: row.message,
  }));
}

/**
 * Deletes a job's lines, or all but the newest `keep`. Returns how many it deleted. The job row is
 * locked like an add, so a clear and an add of the same job cannot interleave.
 */
export async function clearJobLogs(ctx: StoreContext, jobId: string, keep = 0): Promise<number> {
  const id = identifier('jobId', jobId);
  if (!Number.isSafeInteger(keep) || keep < 0) {
    throw new UnsupportedOptionError('keep', 'must be a non-negative integer');
  }
  return ctx.db.run('clearJobLogs', (sql) =>
    runTransaction(sql, async (tx) => {
      await tx`
        SELECT id FROM qcloud_jobs WHERE namespace = ${ctx.namespace} AND id = ${id} FOR UPDATE`;
      if (keep === 0) {
        const gone = await tx`
          DELETE FROM qcloud_job_logs WHERE namespace = ${ctx.namespace} AND job_id = ${id}
          RETURNING id`;
        return gone.length;
      }
      return (await tx.unsafe(TRIM_JOB_LOGS, [ctx.namespace, id, keep])).length;
    })
  );
}
