import { afterEach, beforeEach } from 'bun:test';
import type { WorkflowRepository } from '../src/features/workflows/application/WorkflowRepository';
import {
  parseWorkflowActionResult,
  parseWorkflowDetail,
  parseWorkflowList,
  parseWorkflowSteps,
  type WorkflowActionBody,
} from '../src/features/workflows/domain/workflowWire';
import { WorkflowPage } from '../src/features/workflows/ui/WorkflowPage';
import { BqError } from '../src/lib/bq';
import { demoWorkflowReply, resetDemoWorkflows } from '../src/lib/demo/workflows';
import { settle } from './domSetup';
import { connectTo, disconnect, mountFlows, serveRole, unmountAll } from './flow.helpers';

export const flush = () => settle(20);

/** Connects as an operator before each test and tears down after it; call once at the top of a file. */
export function installWorkflowHooks(role: 'operator' | 'viewer' = 'operator'): void {
  beforeEach(() => {
    resetDemoWorkflows();
    connectTo();
    serveRole(role);
  });
  afterEach(() => {
    unmountAll();
    disconnect();
  });
}

export interface WorkflowCalls {
  lists: string[];
  details: string[];
  steps: string[];
  acts: Array<{ id: string; body: WorkflowActionBody }>;
}

const failed = (reply: { status: number; body: Record<string, unknown> }): never => {
  const { error, code, details } = reply.body as {
    error: string;
    code: string;
    details?: Record<string, unknown>;
  };
  throw new BqError(error, reply.status, code, details);
};

const ok = (reply: { status: number; body: Record<string, unknown> }) =>
  reply.status === 200 ? reply.body : failed(reply);

/** A repository over the demo's runs, which speak the Control API wire; every call is recorded. */
export function demoRepository(
  hooks: { beforeAct?: () => void } = {}
): WorkflowRepository & { calls: WorkflowCalls } {
  const calls: WorkflowCalls = { lists: [], details: [], steps: [], acts: [] };
  return {
    calls,
    async list({ workflowName, state, limit, offset }) {
      const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (workflowName) query.set('name', workflowName);
      if (state) query.set('state', state);
      calls.lists.push(query.toString());
      return parseWorkflowList(ok(demoWorkflowReply(['workflows'], 'GET', `?${query}`)));
    },
    async detail(id, stepsLimit) {
      calls.details.push(id);
      return parseWorkflowDetail(
        ok(demoWorkflowReply(['workflows', 'executions', id], 'GET', `?limit=${stepsLimit}`))
      );
    },
    async steps(id, { iterationOf, status, limit, offset }) {
      const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (iterationOf !== undefined) query.set('iterationOf', iterationOf);
      if (status) query.set('status', status);
      calls.steps.push(query.toString());
      return parseWorkflowSteps(
        ok(demoWorkflowReply(['workflows', 'executions', id, 'steps'], 'GET', `?${query}`))
      );
    },
    async act(_target, id, body) {
      hooks.beforeAct?.();
      calls.acts.push({ id, body });
      return parseWorkflowActionResult(
        ok(demoWorkflowReply(['workflows', 'executions', id, 'actions'], 'POST', '', body))
      );
    },
  };
}

export async function openWorkflows(
  path = '/workflows',
  repository: WorkflowRepository & { calls: WorkflowCalls } = demoRepository()
) {
  const page = mountFlows(<WorkflowPage repository={repository} />, path);
  await flush();
  return { repository, ...page };
}
