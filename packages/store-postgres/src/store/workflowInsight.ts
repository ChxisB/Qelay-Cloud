import type {
  DefinitionListOptions,
  ExecutionCount,
  ExecutionState,
  ExecutionSummary,
  ExecutionSummaryOptions,
  LiveDefinitionCount,
  RollbackStatus,
  WorkflowDefinitionInput,
  WorkflowDefinitionRecord,
  WorkflowGraphNode,
} from '@qelay-cloud/core';
import {
  assertDefinition,
  compareCounts,
  compareLive,
  DEFINITION_RETENTION_MS,
  DEFINITIONS_KEPT_PER_NAME,
  pageBounds,
} from '@qelay-cloud/core';
import type { StoreContext } from './context';

type Time = number | string | bigint;

interface DefinitionRow {
  readonly name: string;
  readonly hash: string;
  readonly revision: string;
  readonly graph: string;
  readonly first_seen_at: Time;
  readonly last_seen_at: Time;
}

/**
 * Announces a definition. The first announcement of a hash inserts it; every later one only moves
 * `last_seen_at` forward (`GREATEST`, so a late write from a slow worker never moves it back). Only an
 * insert prunes: a refresh every few seconds must stay one cheap statement.
 */
export async function recordWorkflowDefinition(
  ctx: StoreContext,
  input: WorkflowDefinitionInput
): Promise<void> {
  assertDefinition(input);
  const graph = JSON.stringify(input.graph);
  await ctx.db.run('recordWorkflowDefinition', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const [row] = await sql<Array<{ inserted: boolean }>>`
      INSERT INTO qcloud_workflow_definitions
        (namespace, name, hash, revision, graph, first_seen_at, last_seen_at)
      VALUES (${ctx.namespace}, ${input.name}, ${input.hash}, ${input.revision}, ${graph},
              ${now}, ${now})
      ON CONFLICT (namespace, name, hash) DO UPDATE
        SET last_seen_at = GREATEST(qcloud_workflow_definitions.last_seen_at, EXCLUDED.last_seen_at)
      RETURNING (xmax = 0) AS inserted`;
    if (row?.inserted !== true) return;
    const cutoff = Math.floor(now - DEFINITION_RETENTION_MS);
    await sql`
      DELETE FROM qcloud_workflow_definitions
      WHERE namespace = ${ctx.namespace} AND name = ${input.name} AND last_seen_at < ${cutoff}
        AND hash NOT IN (
          SELECT hash FROM qcloud_workflow_definitions
          WHERE namespace = ${ctx.namespace} AND name = ${input.name}
          ORDER BY last_seen_at DESC, hash COLLATE "C" LIMIT ${DEFINITIONS_KEPT_PER_NAME})`;
  });
}

export async function listWorkflowDefinitions(
  ctx: StoreContext,
  options: DefinitionListOptions
): Promise<WorkflowDefinitionRecord[]> {
  const rows = await ctx.db.run('listWorkflowDefinitions', (sql) =>
    options.name === undefined
      ? sql<DefinitionRow[]>`
          SELECT name, hash, revision, graph, first_seen_at, last_seen_at
          FROM qcloud_workflow_definitions WHERE namespace = ${ctx.namespace}
          ORDER BY name COLLATE "C", last_seen_at DESC, hash COLLATE "C"`
      : sql<DefinitionRow[]>`
          SELECT name, hash, revision, graph, first_seen_at, last_seen_at
          FROM qcloud_workflow_definitions
          WHERE namespace = ${ctx.namespace} AND name = ${options.name}
          ORDER BY last_seen_at DESC, hash COLLATE "C"`
  );
  return rows.map((row) => ({
    name: row.name,
    hash: row.hash,
    revision: row.revision,
    graph: JSON.parse(row.graph) as WorkflowGraphNode[],
    firstSeenAt: Number(row.first_seen_at),
    lastSeenAt: Number(row.last_seen_at),
  }));
}

interface SummaryRow {
  readonly id: string;
  readonly workflow_name: string;
  readonly state: string;
  readonly definition_hash: string | null;
  readonly parent_execution_id: string | null;
  readonly current_node_index: number;
  readonly rollback_status: string | null;
  readonly failure_reason: string | null;
  readonly committed_at: number | null;
  readonly version: Time;
  readonly created_at: Time;
  readonly updated_at: Time;
  readonly wait_event: string | null;
  readonly wait_deadline: Time | null;
}

/**
 * As `listExecutions`, but only the scalar columns: a page of a big store does not read or decode
 * a single step. The filters change the text of the statement for the same reason as there.
 */
export async function summarizeExecutions(
  ctx: StoreContext,
  options: ExecutionSummaryOptions
): Promise<ExecutionSummary[]> {
  const { limit, offset } = pageBounds(options);
  const values: unknown[] = [ctx.namespace];
  let where = 'namespace = $1';
  if (options.id !== undefined) {
    values.push(options.id);
    where += ` AND id = $${values.length}`;
  }
  if (options.workflowName !== undefined) {
    values.push(options.workflowName);
    where += ` AND workflow_name = $${values.length}`;
  }
  if (options.state !== undefined) {
    values.push(options.state);
    where += ` AND state = $${values.length}`;
  }
  values.push(limit, offset);
  const text = `SELECT id, workflow_name, state, definition_hash, parent_execution_id,
      current_node_index, rollback_status, failure_reason, committed_at, version, created_at,
      updated_at, wait_event, wait_deadline
    FROM qcloud_workflow_executions
    WHERE ${where} ORDER BY created_at DESC, id DESC
    LIMIT $${values.length - 1} OFFSET $${values.length}`;
  const rows = await ctx.db.run('summarizeWorkflowExecutions', (sql) =>
    sql.unsafe<SummaryRow[]>(text, values)
  );
  return rows.map((row) => ({
    id: row.id,
    workflowName: row.workflow_name,
    state: row.state as ExecutionState,
    ...(row.definition_hash === null ? {} : { definitionHash: row.definition_hash }),
    ...(row.parent_execution_id === null ? {} : { parentExecutionId: row.parent_execution_id }),
    currentNodeIndex: Number(row.current_node_index),
    ...(row.rollback_status === null
      ? {}
      : { rollbackStatus: row.rollback_status as RollbackStatus }),
    ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason }),
    ...(row.committed_at === null ? {} : { committedAt: Number(row.committed_at) }),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.wait_event === null ? {} : { waitEvent: row.wait_event }),
    ...(row.wait_deadline === null ? {} : { waitDeadlineAt: Number(row.wait_deadline) }),
  }));
}

/** One index-only pass over `(namespace, workflow_name, state, ...)`; the table is bounded by retention. */
export async function countExecutions(ctx: StoreContext): Promise<ExecutionCount[]> {
  const rows = await ctx.db.run(
    'countWorkflowExecutions',
    (sql) => sql<Array<{ workflow_name: string; state: string; n: number | string }>>`
      SELECT workflow_name, state, count(*)::bigint AS n
      FROM qcloud_workflow_executions WHERE namespace = ${ctx.namespace}
      GROUP BY workflow_name, state`
  );
  return rows
    .map((row) => ({
      workflowName: row.workflow_name,
      state: row.state as ExecutionState,
      count: Number(row.n),
    }))
    .sort(compareCounts);
}

/**
 * Live runs per workflow and definition hash. The partial index on `LIVE_STATES` holds exactly
 * these rows, so the statement reads the index and not the table.
 */
export async function liveExecutionDefinitions(ctx: StoreContext): Promise<LiveDefinitionCount[]> {
  const rows = await ctx.db.run(
    'liveWorkflowDefinitions',
    (sql) => sql<
      Array<{ workflow_name: string; definition_hash: string | null; n: number | string }>
    >`
      SELECT workflow_name, definition_hash, count(*)::bigint AS n
      FROM qcloud_workflow_executions
      WHERE namespace = ${ctx.namespace}
        AND state IN ('running', 'waiting', 'compensating', 'compensation-stuck')
      GROUP BY workflow_name, definition_hash`
  );
  return rows
    .map((row) => ({
      workflowName: row.workflow_name,
      ...(row.definition_hash === null ? {} : { definitionHash: row.definition_hash }),
      count: Number(row.n),
    }))
    .sort(compareLive);
}
