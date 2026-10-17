import type { Execution, ExecutionState, RollbackStatus } from '@qelay-cloud/core';
import { ExecutionTooLargeError } from '../errors';
import type { StoreContext } from './context';

type Time = number | string | bigint;

/** One `qcloud_workflow_executions` row as the driver hands it back. */
export interface ExecutionRow {
  readonly id: string;
  readonly workflow_name: string;
  readonly state: string;
  readonly definition_hash: string | null;
  readonly parent_execution_id: string | null;
  readonly input: Uint8Array;
  readonly steps: Uint8Array;
  readonly current_node_index: number;
  readonly resolved_steps: Uint8Array | null;
  readonly decisions: Uint8Array | null;
  readonly signals: Uint8Array;
  readonly rollback_status: string | null;
  readonly failure_reason: string | null;
  readonly committed_at: number | null;
  readonly version: Time;
  readonly created_at: Time;
  readonly updated_at: Time;
}

/** The columns an archive row shares with a live one, in table order. */
export const EXECUTION_COLUMN_LIST: readonly string[] = [
  'id',
  'workflow_name',
  'state',
  'definition_hash',
  'parent_execution_id',
  'input',
  'steps',
  'current_node_index',
  'resolved_steps',
  'decisions',
  'signals',
  'rollback_status',
  'failure_reason',
  'committed_at',
  'version',
  'created_at',
  'updated_at',
];

export const EXECUTION_COLUMNS = EXECUTION_COLUMN_LIST.join(', ');

/** The columns with a table alias in front, for a query that joins the table to itself. */
export const columnsOf = (alias: string): string =>
  EXECUTION_COLUMN_LIST.map((column) => `${alias}.${column}`).join(', ');

/**
 * The most one encoded column of an execution may take. A run's `steps` holds every step result and
 * grows with the run, so the limit is far above a job's `maxPayloadBytes`: it is a guard against an
 * accident, not a quota.
 */
export const MAX_EXECUTION_BLOB_BYTES = 16 * 1024 * 1024;

/** Encodes one column of `id`, refusing one over `MAX_EXECUTION_BLOB_BYTES`. */
export function blob(ctx: StoreContext, id: string, column: string, value: unknown): Uint8Array {
  const bytes = ctx.codec.encode(value);
  if (bytes.byteLength > MAX_EXECUTION_BLOB_BYTES) {
    throw new ExecutionTooLargeError(id, column, bytes.byteLength, MAX_EXECUTION_BLOB_BYTES);
  }
  return bytes;
}

function optionalBlob(
  ctx: StoreContext,
  id: string,
  column: string,
  value: unknown
): Uint8Array | null {
  return value === undefined ? null : blob(ctx, id, column, value);
}

/** What `update` and `expireWait` write: everything the engine changes while it runs a node. Never `signals`. */
export interface StepColumns {
  readonly steps: Uint8Array;
  readonly resolvedSteps: Uint8Array | null;
  readonly decisions: Uint8Array | null;
  readonly definitionHash: string | null;
  readonly parentExecutionId: string | null;
  readonly rollbackStatus: string | null;
  readonly failureReason: string | null;
  readonly committedAt: number | null;
}

export function stepColumns(ctx: StoreContext, exec: Execution): StepColumns {
  return {
    steps: blob(ctx, exec.id, 'steps', exec.steps),
    resolvedSteps: optionalBlob(ctx, exec.id, 'resolved_steps', exec.resolvedSteps),
    decisions: optionalBlob(ctx, exec.id, 'decisions', exec.decisions),
    definitionHash: exec.definitionHash ?? null,
    parentExecutionId: exec.parentExecutionId ?? null,
    rollbackStatus: exec.rollbackStatus ?? null,
    failureReason: exec.failureReason ?? null,
    committedAt: exec.committedAt ?? null,
  };
}

/** An execution as stored. A column that is null is left off, as an optional field of the type is. */
export function executionOf(ctx: StoreContext, row: ExecutionRow): Execution {
  const { codec } = ctx;
  return {
    id: row.id,
    workflowName: row.workflow_name,
    state: row.state as ExecutionState,
    input: codec.decode(row.input),
    steps: codec.decode(row.steps) as Execution['steps'],
    currentNodeIndex: Number(row.current_node_index),
    ...(row.resolved_steps === null
      ? {}
      : { resolvedSteps: codec.decode(row.resolved_steps) as string[] }),
    ...(row.decisions === null
      ? {}
      : { decisions: codec.decode(row.decisions) as Record<string, unknown> }),
    ...(row.definition_hash === null ? {} : { definitionHash: row.definition_hash }),
    ...(row.rollback_status === null
      ? {}
      : { rollbackStatus: row.rollback_status as RollbackStatus }),
    ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason }),
    ...(row.committed_at === null ? {} : { committedAt: Number(row.committed_at) }),
    signals: codec.decode(row.signals) as Record<string, unknown>,
    ...(row.parent_execution_id === null ? {} : { parentExecutionId: row.parent_execution_id }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    version: Number(row.version),
  };
}
