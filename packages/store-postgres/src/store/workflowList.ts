import type {
  Execution,
  ExecutionListOptions,
  ExecutionState,
  RecoverableOptions,
} from '@qelay-cloud/core';
import {
  ACTIVE_STATES,
  boundedCount,
  DEFAULT_RECOVERABLE_LIMIT,
  MAX_RECOVERABLE_LIMIT,
  pageBounds,
  recoverableStates,
  retentionAge,
} from '@qelay-cloud/core';
import type { StoreContext } from './context';
import type { ExecutionRow } from './workflowRows';
import { columnsOf, EXECUTION_COLUMNS, executionOf } from './workflowRows';

/**
 * Newest first, in pages. The filters change the text of the statement (not just its values), so each
 * of the four shapes is planned on its own index; a `$1 IS NULL OR column = $1` filter would be planned
 * once for all of them and use none.
 */
export async function listExecutions(
  ctx: StoreContext,
  workflowName: string | undefined,
  state: ExecutionState | undefined,
  options: ExecutionListOptions
): Promise<Execution[]> {
  const { limit, offset } = pageBounds(options);
  const values: unknown[] = [ctx.namespace];
  let where = 'namespace = $1';
  if (workflowName !== undefined) {
    values.push(workflowName);
    where += ` AND workflow_name = $${values.length}`;
  }
  if (state !== undefined) {
    values.push(state);
    where += ` AND state = $${values.length}`;
  }
  values.push(limit, offset);
  const text = `SELECT ${EXECUTION_COLUMNS} FROM qcloud_workflow_executions
    WHERE ${where} ORDER BY created_at DESC, id DESC
    LIMIT $${values.length - 1} OFFSET $${values.length}`;
  const rows = await ctx.db.run('listWorkflowExecutions', (sql) =>
    sql.unsafe<ExecutionRow[]>(text, values)
  );
  return rows.map((row) => executionOf(ctx, row));
}

/** Runs whose definition must stay available: oldest progress first, as upstream lists them. */
export async function listActiveExecutions(
  ctx: StoreContext,
  workflowName: string
): Promise<Execution[]> {
  const rows = await ctx.db.run(
    'listActiveWorkflowExecutions',
    (sql) => sql<ExecutionRow[]>`
      SELECT ${sql.unsafe(EXECUTION_COLUMNS)} FROM qcloud_workflow_executions
      WHERE namespace = ${ctx.namespace} AND workflow_name = ${workflowName}
        AND state = ANY(${sql.array([...ACTIVE_STATES], 'TEXT')})
        AND (state <> 'failed' OR rollback_status IS NULL)
      ORDER BY updated_at, id`
  );
  return rows.map((row) => executionOf(ctx, row));
}

/**
 * What recovery may drive, oldest progress first. One index range per state (`(namespace, state,
 * updated_at, id)`), each stopped at `limit`, then the best `limit` of those: a store with a million
 * parked runs reads a few thousand rows, not a million.
 */
export async function listRecoverableExecutions(
  ctx: StoreContext,
  options: RecoverableOptions
): Promise<Execution[]> {
  const limit = boundedCount(
    'Recoverable limit',
    options.limit,
    DEFAULT_RECOVERABLE_LIMIT,
    MAX_RECOVERABLE_LIMIT
  );
  const idle = retentionAge(options.idleMs ?? 0);
  const states = recoverableStates(options.states);
  const rows = await ctx.db.run('listRecoverableWorkflowExecutions', async (sql) => {
    // No idle time asked for: every recoverable run, even one saved by an engine whose clock leads
    // the database's, whose `updated_at` is in the database's future.
    const cutoff =
      idle === 0 ? Number.MAX_SAFE_INTEGER : Math.floor((await ctx.db.time.now(sql)) - idle);
    return sql<ExecutionRow[]>`
      SELECT ${sql.unsafe(columnsOf('x'))}
      FROM unnest(${sql.array(states, 'TEXT')}) AS s(state)
      CROSS JOIN LATERAL (
        SELECT e.* FROM qcloud_workflow_executions e
        WHERE e.namespace = ${ctx.namespace} AND e.state = s.state AND e.updated_at <= ${cutoff}
          AND (e.state <> 'failed' OR e.rollback_status IS NULL)
          AND (e.parent_execution_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM qcloud_workflow_executions p
            WHERE p.namespace = e.namespace AND p.id = e.parent_execution_id))
        ORDER BY e.updated_at, e.id
        LIMIT ${limit}
      ) x
      ORDER BY x.updated_at, x.id
      LIMIT ${limit}`;
  });
  return rows.map((row) => executionOf(ctx, row));
}
