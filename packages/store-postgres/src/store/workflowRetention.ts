import type { ExecutionState } from '@qelay-cloud/core';
import {
  boundedCount,
  DEFAULT_RETENTION_BATCH,
  MAX_RETENTION_BATCH,
  retentionAge,
  retentionStates,
} from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { columnsOf, EXECUTION_COLUMN_LIST, EXECUTION_COLUMNS } from './workflowRows';

const REPLACE_ARCHIVED = EXECUTION_COLUMN_LIST.map(
  (column) => `${column} = EXCLUDED.${column}`
).join(', ');

/**
 * Takes up to `limit` executions in `states` that have made no progress for `maxAgeMs` (inclusive),
 * oldest first, out of the live table, and puts them in the archive too when `keep` is set. One
 * statement: a run is never in neither table, and two callers cannot both take one.
 *
 * The delete repeats the state and age tests, so a run that recovery moved on between the pick and the
 * delete stays: under READ COMMITTED the pick alone would not notice.
 */
export async function retireExecutions(
  ctx: StoreContext,
  maxAgeMs: number,
  states: readonly ExecutionState[],
  limit: number | undefined,
  keep: boolean
): Promise<number> {
  const batch = boundedCount(
    'Retention batch',
    limit,
    DEFAULT_RETENTION_BATCH,
    MAX_RETENTION_BATCH
  );
  const named = retentionStates(states);
  const age = retentionAge(maxAgeMs);
  if (named.length === 0) return 0;
  const rows = await ctx.db.run('retireWorkflowExecutions', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const cutoff = Math.floor(now - age);
    const statesArray = sql.array(named, 'TEXT');
    return sql<Array<{ n: number | string }>>`
      WITH picked AS (
        SELECT x.id, x.updated_at
        FROM unnest(${statesArray}) AS s(state)
        CROSS JOIN LATERAL (
          SELECT e.id, e.updated_at FROM qcloud_workflow_executions e
          WHERE e.namespace = ${ctx.namespace} AND e.state = s.state AND e.updated_at <= ${cutoff}
          ORDER BY e.updated_at, e.id
          LIMIT ${batch}
        ) x
        ORDER BY x.updated_at, x.id
        LIMIT ${batch}
      ), gone AS (
        DELETE FROM qcloud_workflow_executions t
        USING picked
        WHERE t.namespace = ${ctx.namespace} AND t.id = picked.id
          AND t.state = ANY(${statesArray}) AND t.updated_at <= ${cutoff}
        RETURNING ${sql.unsafe(columnsOf('t'))}
      ), kept AS (
        INSERT INTO qcloud_workflow_executions_archive (namespace, ${sql.unsafe(EXECUTION_COLUMNS)}, archived_at)
        SELECT ${ctx.namespace}::text, ${sql.unsafe(EXECUTION_COLUMNS)}, ${now}::bigint FROM gone
        WHERE ${keep}::boolean
        ON CONFLICT (namespace, id) DO UPDATE SET ${sql.unsafe(REPLACE_ARCHIVED)}, archived_at = EXCLUDED.archived_at
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM gone`;
  });
  return Number(rows[0]?.n ?? 0);
}

export async function archivedExecutionCount(ctx: StoreContext): Promise<number> {
  const [row] = await ctx.db.run(
    'countArchivedWorkflowExecutions',
    (sql) => sql<Array<{ n: number | string }>>`
      SELECT count(*)::int AS n FROM qcloud_workflow_executions_archive
      WHERE namespace = ${ctx.namespace}`
  );
  return Number(row?.n ?? 0);
}
