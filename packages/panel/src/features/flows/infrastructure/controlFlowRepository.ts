import { assertCurrentServerRequestTarget } from '@/lib/bq';
import { body, srv } from '@/lib/bq/transport';
import type { JobFull } from '@/lib/bqTypes';
import type { FlowRepository } from '../application/FlowRepository';
import { parseFlowActionResult, parseFlowList, parseFlowView } from '../domain/flowWire';

const segment = (id: string): string => encodeURIComponent(id);

export const controlFlowRepository: FlowRepository = {
  async list({ limit, offset }, signal) {
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    return parseFlowList(await srv<unknown>(`/flows?${query}`, signal ? { signal } : undefined));
  },

  async view(root, limit, signal) {
    return parseFlowView(
      await srv<unknown>(`/flows/${segment(root)}?limit=${limit}`, signal ? { signal } : undefined)
    );
  },

  async rootOf(jobId, signal) {
    const { job } = await srv<{ job: JobFull }>(
      `/jobs/${segment(jobId)}`,
      signal ? { signal } : undefined
    );
    return job.flowRoot ?? null;
  },

  async act(target, root, request) {
    assertCurrentServerRequestTarget(target);
    return parseFlowActionResult(
      await srv<unknown>(`/flows/${segment(root)}/actions`, body('POST', request))
    );
  },
};
