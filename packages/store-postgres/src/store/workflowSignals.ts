import type {
  ClaimWaitsOptions,
  DueWait,
  Execution,
  ExecutionState,
  ParkOutcome,
  SignalOutcome,
  WaitExpiryOutcome,
} from '@qelay-cloud/core';
import {
  boundedCount,
  DEFAULT_WAIT_BATCH,
  DEFAULT_WAIT_LEASE_MS,
  hasSignal,
  isLive,
  MAX_WAIT_BATCH,
  SignalRejectedError,
  setSignal,
  waitDeadline,
} from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { StoreContext } from './context';
import { runTransaction } from './retry';
import { blob, stepColumns } from './workflowRows';

/** The longest lease a wait claim may take: an hour, as long as any caller has a reason to hold one. */
const MAX_WAIT_LEASE_MS = 3_600_000;

interface LockedRow {
  readonly workflow_name: string;
  readonly state: string;
  readonly current_node_index: number;
  readonly signals: Uint8Array;
}

/**
 * The row, locked for the rest of the transaction. Everything that decides on `signals` goes through
 * it, so two callers on one run are serialised: the first records, the second sees the first.
 */
async function lockExecution(
  tx: TransactionSQL,
  ctx: StoreContext,
  id: string
): Promise<LockedRow | null> {
  const [row] = await tx<LockedRow[]>`
    SELECT workflow_name, state, current_node_index, signals
    FROM qcloud_workflow_executions
    WHERE namespace = ${ctx.namespace} AND id = ${id}
    FOR UPDATE`;
  return row ?? null;
}

const signalsOf = (ctx: StoreContext, row: LockedRow): Record<string, unknown> =>
  ctx.codec.decode(row.signals) as Record<string, unknown>;

export function recordExecutionSignal(
  ctx: StoreContext,
  id: string,
  event: string,
  payload: unknown
): Promise<SignalOutcome> {
  return ctx.db.run('recordWorkflowSignal', (sql) =>
    runTransaction(sql, async (tx): Promise<SignalOutcome> => {
      const row = await lockExecution(tx, ctx, id);
      if (!row) return { found: false, resumed: false, workflowName: '', currentNodeIndex: 0 };
      const state = row.state as ExecutionState;
      if (!isLive(state)) throw new SignalRejectedError(id, event, 'state', state);
      const signals = signalsOf(ctx, row);
      if (hasSignal(signals, event)) throw new SignalRejectedError(id, event, 'duplicate');
      setSignal(signals, event, payload);
      const bytes = blob(ctx, id, 'signals', signals);
      const now = await ctx.db.time.now(tx);
      // The one caller that finds the run parked moves it on; the lock makes that caller unique.
      const resumed = state === 'waiting';
      await tx`
        UPDATE qcloud_workflow_executions
        SET signals = ${bytes}, updated_at = ${now}, state = ${resumed ? 'running' : state},
            version = version + ${resumed ? 1 : 0}, wait_event = NULL, wait_deadline = NULL,
            wait_lease_until = NULL
        WHERE namespace = ${ctx.namespace} AND id = ${id}`;
      return {
        found: true,
        resumed,
        workflowName: row.workflow_name,
        currentNodeIndex: Number(row.current_node_index),
      };
    })
  );
}

export function restoreExecutionWait(
  ctx: StoreContext,
  id: string,
  event: string,
  nodeIndex: number
): Promise<boolean> {
  return ctx.db.run('restoreWorkflowWait', (sql) =>
    runTransaction(sql, async (tx) => {
      const row = await lockExecution(tx, ctx, id);
      if (!row || Number(row.current_node_index) !== nodeIndex || row.state !== 'running') {
        return false;
      }
      if (!hasSignal(signalsOf(ctx, row), event)) return false;
      const now = await ctx.db.time.now(tx);
      await tx`
        UPDATE qcloud_workflow_executions
        SET state = 'waiting', updated_at = ${now}, version = version + 1,
            wait_event = ${event}, wait_deadline = NULL, wait_lease_until = NULL
        WHERE namespace = ${ctx.namespace} AND id = ${id}`;
      return true;
    })
  );
}

export async function parkExecution(
  ctx: StoreContext,
  id: string,
  event: string,
  deadlineAt?: number
): Promise<ParkOutcome> {
  const deadline = waitDeadline(deadlineAt);
  return ctx.db.run('parkWorkflowForSignal', (sql) =>
    runTransaction(sql, async (tx): Promise<ParkOutcome> => {
      const row = await lockExecution(tx, ctx, id);
      if (!row) return { signalPresent: false, parked: false, signals: {} };
      const signals = signalsOf(ctx, row);
      if (hasSignal(signals, event)) return { signalPresent: true, parked: false, signals };
      const state = row.state as ExecutionState;
      if (!isLive(state)) return { signalPresent: false, parked: false, signals };
      const now = await ctx.db.time.now(tx);
      await tx`
        UPDATE qcloud_workflow_executions
        SET state = 'waiting', updated_at = ${now}, version = version + ${state === 'running' ? 1 : 0},
            wait_event = ${event}, wait_deadline = ${deadline}, wait_lease_until = NULL
        WHERE namespace = ${ctx.namespace} AND id = ${id}`;
      return { signalPresent: false, parked: true, signals };
    })
  );
}

export async function expireExecutionWait(
  ctx: StoreContext,
  failed: Execution,
  event: string,
  nodeIndex: number
): Promise<WaitExpiryOutcome> {
  const step = stepColumns(ctx, failed);
  return ctx.db.run('expireWorkflowWait', (sql) =>
    runTransaction(sql, async (tx): Promise<WaitExpiryOutcome> => {
      const row = await lockExecution(tx, ctx, failed.id);
      if (
        !row ||
        Number(row.current_node_index) !== nodeIndex ||
        !isLive(row.state as ExecutionState)
      ) {
        return { kind: 'moved' };
      }
      const signals = signalsOf(ctx, row);
      if (hasSignal(signals, event)) return { kind: 'signalled', signals };
      const now = await ctx.db.time.now(tx);
      const [written] = await tx<Array<{ version: number | string | bigint }>>`
        UPDATE qcloud_workflow_executions
        SET state = 'failed', steps = ${step.steps}, resolved_steps = ${step.resolvedSteps},
            decisions = ${step.decisions}, definition_hash = ${step.definitionHash},
            parent_execution_id = ${step.parentExecutionId}, rollback_status = ${step.rollbackStatus},
            failure_reason = ${step.failureReason}, committed_at = ${step.committedAt},
            version = version + 1, updated_at = ${now}, wait_event = NULL, wait_deadline = NULL,
            wait_lease_until = NULL
        WHERE namespace = ${ctx.namespace} AND id = ${failed.id}
        RETURNING version`;
      failed.updatedAt = now;
      failed.version = Number(written!.version);
      return { kind: 'expired' };
    })
  );
}

interface DueRow {
  readonly id: string;
  readonly workflow_name: string;
  readonly wait_event: string;
  readonly current_node_index: number;
  readonly wait_deadline: number | string | bigint;
}

export async function claimDueExecutionWaits(
  ctx: StoreContext,
  options: ClaimWaitsOptions = {}
): Promise<DueWait[]> {
  const limit = boundedCount('Wait claim limit', options.limit, DEFAULT_WAIT_BATCH, MAX_WAIT_BATCH);
  const leaseMs = boundedCount(
    'Wait lease',
    options.leaseMs,
    DEFAULT_WAIT_LEASE_MS,
    MAX_WAIT_LEASE_MS
  );
  const rows = await ctx.db.run('claimDueWorkflowWaits', async (sql) => {
    const now = await ctx.db.time.now(sql);
    return sql<DueRow[]>`
      WITH due AS MATERIALIZED (
        SELECT id FROM qcloud_workflow_executions
        WHERE namespace = ${ctx.namespace} AND state = 'waiting' AND wait_deadline IS NOT NULL
          AND wait_deadline <= ${now} AND (wait_lease_until IS NULL OR wait_lease_until <= ${now})
        ORDER BY wait_deadline, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE qcloud_workflow_executions e
      SET wait_lease_until = ${now + leaseMs}
      FROM due
      WHERE e.namespace = ${ctx.namespace} AND e.id = due.id
      RETURNING e.id, e.workflow_name, e.wait_event, e.current_node_index, e.wait_deadline`;
  });
  return rows
    .map((row) => ({
      id: row.id,
      workflowName: row.workflow_name,
      event: row.wait_event,
      nodeIndex: Number(row.current_node_index),
      deadlineAt: Number(row.wait_deadline),
    }))
    .sort((a, b) => a.deadlineAt - b.deadlineAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
