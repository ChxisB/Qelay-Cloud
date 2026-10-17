import type { Execution } from '@qelay-cloud/core';
import { assertNewExecution, ExecutionExistsError, ExecutionStaleError } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import type { ExecutionRow } from './workflowRows';
import { blob, EXECUTION_COLUMNS, executionOf, stepColumns } from './workflowRows';

/** Inserts a new execution at version 0. */
export async function saveExecution(ctx: StoreContext, exec: Execution): Promise<void> {
  assertNewExecution(exec);
  const input = blob(ctx, exec.id, 'input', exec.input);
  const signals = blob(ctx, exec.id, 'signals', exec.signals);
  const step = stepColumns(ctx, exec);
  const inserted = await ctx.db.run(
    'saveWorkflowExecution',
    (sql) => sql<Array<{ id: string }>>`
      INSERT INTO qcloud_workflow_executions
        (namespace, id, workflow_name, state, definition_hash, parent_execution_id, input, steps,
         current_node_index, resolved_steps, decisions, signals, rollback_status, failure_reason,
         committed_at, version, created_at, updated_at)
      VALUES
        (${ctx.namespace}, ${exec.id}, ${exec.workflowName}, ${exec.state}, ${step.definitionHash},
         ${step.parentExecutionId}, ${input}, ${step.steps}, ${exec.currentNodeIndex},
         ${step.resolvedSteps}, ${step.decisions}, ${signals}, ${step.rollbackStatus},
         ${step.failureReason}, ${step.committedAt}, 0, ${exec.createdAt}, ${exec.updatedAt})
      ON CONFLICT (namespace, id) DO NOTHING
      RETURNING id`
  );
  if (inserted.length === 0) throw new ExecutionExistsError(exec.id);
  exec.version = 0;
}

export async function getExecution(ctx: StoreContext, id: string): Promise<Execution | null> {
  const [row] = await ctx.db.run(
    'getWorkflowExecution',
    (sql) => sql<ExecutionRow[]>`
      SELECT ${sql.unsafe(EXECUTION_COLUMNS)} FROM qcloud_workflow_executions
      WHERE namespace = ${ctx.namespace} AND id = ${id}`
  );
  return row ? executionOf(ctx, row) : null;
}

/** The first child saved: upstream's `created_at ASC, id ASC`. */
export async function findChildExecution(
  ctx: StoreContext,
  parentExecutionId: string,
  workflowName: string
): Promise<Execution | null> {
  const [row] = await ctx.db.run(
    'findWorkflowChild',
    (sql) => sql<ExecutionRow[]>`
      SELECT ${sql.unsafe(EXECUTION_COLUMNS)} FROM qcloud_workflow_executions
      WHERE namespace = ${ctx.namespace} AND parent_execution_id = ${parentExecutionId}
        AND workflow_name = ${workflowName}
      ORDER BY created_at, id
      LIMIT 1`
  );
  return row ? executionOf(ctx, row) : null;
}

export async function removeExecution(ctx: StoreContext, id: string): Promise<boolean> {
  const removed = await ctx.db.run(
    'removeWorkflowExecution',
    (sql) => sql<Array<{ id: string }>>`
      DELETE FROM qcloud_workflow_executions
      WHERE namespace = ${ctx.namespace} AND id = ${id}
      RETURNING id`
  );
  return removed.length === 1;
}

/**
 * The compare-and-set write. `signals` is not in the statement, so a signal recorded while the node
 * ran survives; `version` is, so a second engine that read the same row is refused.
 */
export async function updateExecution(ctx: StoreContext, exec: Execution): Promise<void> {
  if (exec.version === undefined) {
    throw new TypeError('update() needs an execution that was read from the store (no version)');
  }
  const step = stepColumns(ctx, exec);
  const written = await ctx.db.run('updateWorkflowExecution', async (sql) => {
    const now = await ctx.db.time.now(sql);
    return sql<Array<{ version: number | string | bigint; updated_at: number | string | bigint }>>`
      UPDATE qcloud_workflow_executions
      SET state = ${exec.state}, steps = ${step.steps}, current_node_index = ${exec.currentNodeIndex},
          resolved_steps = ${step.resolvedSteps}, decisions = ${step.decisions},
          definition_hash = ${step.definitionHash}, parent_execution_id = ${step.parentExecutionId},
          rollback_status = ${step.rollbackStatus}, failure_reason = ${step.failureReason},
          committed_at = ${step.committedAt}, version = version + 1, updated_at = ${now},
          wait_event = CASE WHEN ${exec.state}::text = 'waiting' THEN wait_event END,
          wait_deadline = CASE WHEN ${exec.state}::text = 'waiting' THEN wait_deadline END,
          wait_lease_until = CASE WHEN ${exec.state}::text = 'waiting' THEN wait_lease_until END
      WHERE namespace = ${ctx.namespace} AND id = ${exec.id} AND version = ${exec.version}
      RETURNING version, updated_at`;
  });
  const row = written[0];
  if (row) {
    exec.version = Number(row.version);
    exec.updatedAt = Number(row.updated_at);
    return;
  }
  const [current] = await ctx.db.run(
    'readWorkflowVersion',
    (sql) => sql<Array<{ version: number | string | bigint }>>`
      SELECT version FROM qcloud_workflow_executions
      WHERE namespace = ${ctx.namespace} AND id = ${exec.id}`
  );
  throw new ExecutionStaleError(exec.id, exec.version, current ? Number(current.version) : null);
}
