import type { JobState } from '@qelay-cloud/core';
import { JOB_STATES } from '@qelay-cloud/core';
import type { JobDetails, PostgresStore } from '@qelay-cloud/store-postgres';
import { z } from 'zod';
import { ApiError } from '../errors';
import type { JobsConfig } from './limits';

/**
 * Lists of jobs. Two modes, both bounded, neither a scan:
 *
 * - `offset` (the panel's pages): the requested states are read in the order given, each in the
 *   store's own order (claim order for waiting and prioritized, `run_at` for delayed, newest first for
 *   the rest). `total` comes from one count per queue. Past `maxOffset` (100,000 by default) the
 *   request is a 400 that points at the cursor, because a deep offset is a read of every row before it.
 * - `cursor`: sent, even empty, it pages by job id with the store's keyset read, at any depth, and the
 *   answer carries `next` (null at the end). There is no `total`.
 */

export const listQuery = z.object({
  states: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().max(512).optional(),
});

export type ListQuery = z.infer<typeof listQuery>;

/** `waiting,delayed` as states. Empty or absent is every state. */
export function parseStates(text: string | undefined): JobState[] {
  if (text === undefined || text.trim() === '') return [...JOB_STATES];
  const names = [
    ...new Set(
      text
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '')
    ),
  ];
  const known = new Set<string>(JOB_STATES);
  const unknown = names.find((name) => !known.has(name));
  if (unknown !== undefined) {
    throw ApiError.invalid('a state is not known', { allowed: [...JOB_STATES] });
  }
  return names as JobState[];
}

export interface JobPage {
  readonly jobs: readonly JobDetails[];
  readonly limit: number;
  /** Offset mode only. */
  readonly offset?: number;
  readonly total?: number;
  /** Cursor mode only: pass it as `cursor` for the next page; null at the end. */
  readonly next?: string | null;
}

/** One page of jobs, each read in full (one query for the page). */
export async function readJobPage(
  store: PostgresStore,
  queue: string,
  query: ListQuery,
  config: JobsConfig
): Promise<JobPage> {
  const states = parseStates(query.states);
  const limit = Math.min(query.limit ?? config.defaultPageSize, config.maxPageSize);
  if (query.cursor !== undefined) {
    const page = await store.listJobs({
      queue,
      states,
      limit,
      ...(query.cursor === '' ? {} : { cursor: query.cursor }),
    });
    const jobs = await store.control.detailsMany(page.items.map((job) => job.id));
    return { jobs, limit, next: page.next };
  }
  const offset = query.offset ?? 0;
  if (offset > config.maxOffset) {
    throw new ApiError(
      400,
      'offset_too_large',
      `offset is limited to ${config.maxOffset}: page deeper with cursor`,
      { maxOffset: config.maxOffset, use: 'cursor' }
    );
  }
  const counts = await store.counts(queue);
  const total = states.reduce((sum, state) => sum + counts[state], 0);
  const ids: string[] = [];
  let skip = offset;
  for (const state of states) {
    const size = counts[state];
    if (skip >= size) {
      skip -= size;
      continue;
    }
    const page = await store.readModels.jobsByState(queue, state, {
      limit: limit - ids.length,
      offset: skip,
    });
    skip = 0;
    ids.push(...page.items.map((job) => job.id));
    if (ids.length >= limit) break;
  }
  const jobs = await store.control.detailsMany(ids);
  return { jobs, limit, offset, total };
}
