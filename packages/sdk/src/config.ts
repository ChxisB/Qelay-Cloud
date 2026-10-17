import type { DlqEntry } from '@qelay-cloud/core';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { DlqStats, LogLevel, WorkerInfo } from '@qelay-cloud/store-postgres';
import { DEFAULT_PAGE_SIZE } from '@qelay-cloud/store-postgres';
import type { Job } from './job';
import { fromDetails } from './job';
import { addLog, ownedRecord } from './jobOps';
import type { Runtime } from './runtime';

/** Per-queue settings, the DLQ and the job logs. */

export interface StallConfig {
  readonly maxStalls: number;
}

export interface DlqConfig {
  readonly maxEntries: number;
  readonly maxAge: number | null;
}

export interface DlqFilter {
  readonly limit?: number;
  readonly offset?: number;
}

export interface JobLogs {
  /** Each line as `[level] message`, oldest first. */
  readonly logs: string[];
  /** Lines the job holds, not only the lines returned. */
  readonly count: number;
}

function only(prefix: string, given: object, allowed: readonly string[]): void {
  for (const key of Object.keys(given)) {
    if (!allowed.includes(key)) {
      throw new UnsupportedOptionError(`${prefix}.${key}`, 'is not supported (docs/compat.md)');
    }
  }
}

export async function setStall(rt: Runtime, config: Partial<StallConfig>): Promise<StallConfig> {
  only('stallConfig', config, ['maxStalls']);
  return (await rt.store.queues.setStallConfig(rt.name, config)).stall;
}

export async function getStall(rt: Runtime): Promise<StallConfig> {
  return (await rt.store.queues.config(rt.name)).stall;
}

export async function setDlq(rt: Runtime, config: Partial<DlqConfig>): Promise<DlqConfig> {
  only('dlqConfig', config, ['maxEntries', 'maxAge']);
  return (await rt.store.queues.setDlqConfig(rt.name, config)).dlq;
}

export async function getDlq(rt: Runtime): Promise<DlqConfig> {
  return (await rt.store.queues.config(rt.name)).dlq;
}

/** One page of the DLQ, oldest failure first. The entry names the job: read it with `getJob`. */
export async function dlqEntries(rt: Runtime, filter: DlqFilter = {}): Promise<DlqEntry[]> {
  only('filter', filter, ['limit', 'offset']);
  const { limit = DEFAULT_PAGE_SIZE, offset } = filter;
  const page = await rt.store.listDlqPage(rt.name, {
    limit,
    ...(offset === undefined ? {} : { offset }),
  });
  return [...page.items];
}

/** The failed jobs of the first `count` DLQ entries, as jobs. */
export async function dlqJobs<T>(rt: Runtime, count = DEFAULT_PAGE_SIZE): Promise<Array<Job<T>>> {
  const entries = await dlqEntries(rt, { limit: count });
  const details = await rt.store.control.detailsMany(entries.map((entry) => entry.jobId));
  return details.map((one) => fromDetails<T>(rt, one));
}

export function dlqStats(rt: Runtime): Promise<DlqStats> {
  return rt.store.dlqStats(rt.name);
}

/** Deletes every DLQ entry and its failed job. Returns how many. */
export function purgeDlq(rt: Runtime): Promise<number> {
  return rt.store.purgeDlq(rt.name);
}

/** True when the queue's DLQ held the job and it is gone. */
export async function removeDlqJob(rt: Runtime, id: string): Promise<boolean> {
  return (await rt.store.purgeDlq(rt.name, [id])) > 0;
}

export async function setConcurrency(rt: Runtime, concurrency: number | null): Promise<void> {
  await rt.store.setConcurrencyLimit(rt.name, concurrency);
}

export async function getConcurrency(rt: Runtime): Promise<number | null> {
  return (await rt.store.queues.config(rt.name)).concurrencyLimit;
}

/** At most `max` claims in each window of `durationMs` (default 1,000). */
export async function setRateLimit(rt: Runtime, max: number, durationMs?: number): Promise<void> {
  await rt.store.setRateLimit(rt.name, {
    max,
    ...(durationMs === undefined ? {} : { durationMs }),
  });
}

export async function clearRateLimit(rt: Runtime): Promise<void> {
  await rt.store.setRateLimit(rt.name, null);
}

export async function getRateLimit(rt: Runtime): Promise<{ max: number; duration: number } | null> {
  const limit = (await rt.store.queues.config(rt.name)).rateLimit;
  return limit === null ? null : { max: limit.max, duration: limit.durationMs };
}

export async function jobLogs(rt: Runtime, id: string, start = 0, end = -1): Promise<JobLogs> {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < -1) {
    throw new UnsupportedOptionError(
      'start',
      'and end must be integers: start at least 0, end -1 or more'
    );
  }
  if ((await ownedRecord(rt, id)) === null) return { logs: [], count: 0 };
  const lines = await rt.store.logs.list(id);
  const wanted = lines.slice(start, end === -1 ? undefined : end + 1);
  return { logs: wanted.map((line) => `[${line.level}] ${line.message}`), count: lines.length };
}

/** `keepLogs` trims the job to its newest lines afterwards. Returns how many lines it holds. */
export async function appendLog(
  rt: Runtime,
  id: string,
  message: string,
  keepLogs?: number,
  level?: LogLevel
): Promise<number> {
  const count = await addLog(rt, id, message, level);
  if (keepLogs === undefined) return count;
  await rt.store.logs.clear(id, keepLogs);
  return (await rt.store.logs.list(id)).length;
}

export async function clearLogs(rt: Runtime, id: string, keepLogs?: number): Promise<void> {
  if ((await ownedRecord(rt, id)) === null) return;
  await rt.store.logs.clear(id, keepLogs);
}

/** The workers registered in the namespace that take jobs of this queue. */
export async function queueWorkers(rt: Runtime): Promise<WorkerInfo[]> {
  return (await rt.store.workers.list()).filter((worker) => worker.queues.includes(rt.name));
}
