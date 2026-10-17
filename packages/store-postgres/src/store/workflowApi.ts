import type { WorkflowStorePort } from '@qelay-cloud/core';
import { DEFAULT_RETENTION_STATES } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import {
  findChildExecution,
  getExecution,
  removeExecution,
  saveExecution,
  updateExecution,
} from './workflowCrud';
import {
  countExecutions,
  listWorkflowDefinitions,
  liveExecutionDefinitions,
  recordWorkflowDefinition,
  summarizeExecutions,
} from './workflowInsight';
import { listActiveExecutions, listExecutions, listRecoverableExecutions } from './workflowList';
import { archivedExecutionCount, retireExecutions } from './workflowRetention';
import {
  claimDueExecutionWaits,
  expireExecutionWait,
  parkExecution,
  recordExecutionSignal,
  restoreExecutionWait,
} from './workflowSignals';

/**
 * Durable workflow executions (`store.workflows`): the Postgres implementation of core's
 * `WorkflowStorePort`, which the workflow engine depends on. The port's comments are the contract.
 * Nothing here rings a bell or touches the network.
 */
export type WorkflowApi = WorkflowStorePort;

export const workflowApi = (ctx: StoreContext): WorkflowApi => ({
  now: () => ctx.db.run('workflowNow', (sql) => ctx.db.time.now(sql)),
  save: (exec) => saveExecution(ctx, exec),
  get: (id) => getExecution(ctx, id),
  findChild: (parentExecutionId, workflowName) =>
    findChildExecution(ctx, parentExecutionId, workflowName),
  remove: (id) => removeExecution(ctx, id),
  update: (exec) => updateExecution(ctx, exec),
  recordSignal: (id, event, payload) => recordExecutionSignal(ctx, id, event, payload),
  restoreSignalWait: (id, event, nodeIndex) => restoreExecutionWait(ctx, id, event, nodeIndex),
  parkForSignal: (id, event, deadlineAt) => parkExecution(ctx, id, event, deadlineAt),
  expireWait: (failed, event, nodeIndex) => expireExecutionWait(ctx, failed, event, nodeIndex),
  claimDueWaits: (options) => claimDueExecutionWaits(ctx, options),
  list: (workflowName, state, options = {}) => listExecutions(ctx, workflowName, state, options),
  listActive: (workflowName) => listActiveExecutions(ctx, workflowName),
  listRecoverable: (options = {}) => listRecoverableExecutions(ctx, options),
  cleanup: (maxAgeMs, states, limit) =>
    retireExecutions(ctx, maxAgeMs, states ?? DEFAULT_RETENTION_STATES, limit, false),
  archive: (maxAgeMs, states, limit) =>
    retireExecutions(ctx, maxAgeMs, states ?? DEFAULT_RETENTION_STATES, limit, true),
  getArchivedCount: () => archivedExecutionCount(ctx),
  recordDefinition: (input) => recordWorkflowDefinition(ctx, input),
  listDefinitions: (options = {}) => listWorkflowDefinitions(ctx, options),
  summaries: (options = {}) => summarizeExecutions(ctx, options),
  counts: () => countExecutions(ctx),
  liveDefinitions: () => liveExecutionDefinitions(ctx),
});
