import { expect } from 'bun:test';
import { until } from '../../packages/sdk/test/workerSupport';
import type { Stack, StackKind, StackOptions } from './stack';

export { until };

/** One end-to-end behaviour, run once per kind of stack. */
export interface Scenario {
  readonly name: string;
  /** The group `bun run test:scenarios --suite=<name>` selects. Absent: only the full run has it. */
  readonly suite?: string;
  readonly stack?: StackOptions;
  /** Kinds it does not apply to, with the reason. */
  readonly skip?: Partial<Record<StackKind, string>>;
  readonly timeoutMs?: number;
  run(stack: Stack): Promise<void>;
}

/** Who ran which job, when: the evidence of "exactly once" and of "not before its time". */
export class Ledger {
  readonly runs = new Map<string, Array<{ at: number; attemptsMade: number }>>();

  record(id: string, attemptsMade: number): number {
    const list = this.runs.get(id) ?? [];
    list.push({ at: Date.now(), attemptsMade });
    this.runs.set(id, list);
    return list.length;
  }

  count(id: string): number {
    return this.runs.get(id)?.length ?? 0;
  }

  get total(): number {
    let sum = 0;
    for (const list of this.runs.values()) sum += list.length;
    return sum;
  }
}

const TERMINAL = new Set(['completed', 'failed']);

/**
 * The reconciliation every scenario ends with: each job it added is in the database exactly once, in
 * a terminal state, and nothing is left active or waiting. A lost job fails the first assertion, and
 * a stuck one the second.
 */
export async function reconcile(
  stack: Stack,
  ids: readonly string[]
): Promise<Map<string, { state: string; attempts: number }>> {
  const rows = await stack.fresh.sql<Array<{ id: string; state: string; attempts: number }>>`
    SELECT id, state, attempts FROM qcloud_jobs
    WHERE namespace = ${stack.namespace} AND id IN ${stack.fresh.sql(ids as string[])}`;
  expect(rows.length).toBe(new Set(ids).size);
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) {
    expect(TERMINAL.has(byId.get(id)?.state ?? 'missing')).toBe(true);
  }
  const unfinished = await stack.fresh.sql<Array<{ n: string }>>`
    SELECT count(*) AS n FROM qcloud_jobs
    WHERE namespace = ${stack.namespace} AND state NOT IN ('completed', 'failed')`;
  expect(Number(unfinished[0]!.n)).toBe(0);
  return byId;
}

/** Waits until every id is `completed` or `failed`. */
export async function untilFinished(
  stack: Stack,
  ids: readonly string[],
  ms = 20_000
): Promise<void> {
  await until(
    `${ids.length} jobs to finish`,
    async () => {
      const rows = await stack.fresh.sql<Array<{ n: string }>>`
        SELECT count(*) AS n FROM qcloud_jobs
        WHERE namespace = ${stack.namespace} AND id IN ${stack.fresh.sql(ids as string[])}
          AND state IN ('completed', 'failed')`;
      return Number(rows[0]!.n) === new Set(ids).size;
    },
    ms
  );
}

/** Milliseconds on the database clock: what `run_at` and `next_run` are measured in. */
export async function dbNow(stack: Stack): Promise<number> {
  const rows = await stack.fresh.sql<Array<{ now: string }>>`
    SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now`;
  return Number(rows[0]!.now);
}
