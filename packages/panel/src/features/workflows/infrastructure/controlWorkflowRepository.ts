import { assertCurrentServerRequestTarget } from '@/lib/bq';
import { body, srv } from '@/lib/bq/transport';
import type { WorkflowRepository } from '../application/WorkflowRepository';
import {
  parseWorkflowActionResult,
  parseWorkflowDetail,
  parseWorkflowList,
  parseWorkflowSteps,
} from '../domain/workflowWire';

const segment = (id: string): string => encodeURIComponent(id);
const init = (signal?: AbortSignal) => (signal ? { signal } : undefined);

export const controlWorkflowRepository: WorkflowRepository = {
  async list({ workflowName, state, limit, offset }, signal) {
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (workflowName) query.set('name', workflowName);
    if (state) query.set('state', state);
    return parseWorkflowList(await srv<unknown>(`/workflows?${query}`, init(signal)));
  },

  async detail(id, stepsLimit, signal) {
    return parseWorkflowDetail(
      await srv<unknown>(`/workflows/executions/${segment(id)}?limit=${stepsLimit}`, init(signal))
    );
  },

  async steps(id, { iterationOf, status, limit, offset }, signal) {
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (iterationOf !== undefined) query.set('iterationOf', iterationOf);
    if (status) query.set('status', status);
    return parseWorkflowSteps(
      await srv<unknown>(`/workflows/executions/${segment(id)}/steps?${query}`, init(signal))
    );
  },

  async act(target, id, request) {
    assertCurrentServerRequestTarget(target);
    return parseWorkflowActionResult(
      await srv<unknown>(`/workflows/executions/${segment(id)}/actions`, body('POST', request))
    );
  },
};
