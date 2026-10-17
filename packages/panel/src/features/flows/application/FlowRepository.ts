import type { ServerRequestTarget } from '@/lib/bq';
import type { FlowActionBody, FlowActionResult, FlowList, FlowView } from '../domain/flowWire';

/** What the Flows page needs from the Control API. */
export interface FlowRepository {
  /** A page of flow roots, newest first. */
  list(page: { limit: number; offset: number }, signal?: AbortSignal): Promise<FlowList>;
  /** The flow whose root is `root`: at most `limit` jobs. A `BqError` 404 `flow_not_found` when there is none. */
  view(root: string, limit: number, signal?: AbortSignal): Promise<FlowView>;
  /** The root of the flow `jobId` belongs to, or null when the job is in no flow. */
  rootOf(jobId: string, signal?: AbortSignal): Promise<string | null>;
  /** One action, applied whole or refused. `target` is the connection the operator was looking at. */
  act(target: ServerRequestTarget, root: string, body: FlowActionBody): Promise<FlowActionResult>;
}
