import type { FlowActionRequest, FlowRefusal } from '@qelay-cloud/core';
import { MAX_FLOW_JOBS, MAX_FLOW_VIEW_NODES } from '@qelay-cloud/core';
import { z } from 'zod';
import { ApiError } from '../errors';

/** `GET /flows`: a page of roots, newest first. */
export const flowListQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** `GET /flows/:id`: how many jobs of the flow to list (at most `MAX_FLOW_VIEW_NODES`). */
export const flowViewQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_FLOW_VIEW_NODES).optional(),
});

/**
 * `POST /flows/:id/actions`. Strict, like every action body: a misspelt `expectedVersion` would be
 * dropped and the action would run unfenced. Every job the action touches is named with the version
 * the caller read, so a flow that changed since it was shown is refused and not acted on.
 */
export const flowActionBody = z.strictObject({
  action: z.enum(['retry-failed', 'promote', 'remove']),
  jobs: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        expectedVersion: z.number().int().min(0),
      })
    )
    .min(1)
    .max(MAX_FLOW_JOBS),
  /** `promote`: the waiting parent to let go of the failed children that hold it. */
  parent: z.string().min(1).optional(),
  /** `remove` deletes jobs for good: it takes the flow's root id. */
  confirm: z.string().optional(),
});

export type FlowActionBody = z.infer<typeof flowActionBody>;

/** The body of a `POST` that names up to `MAX_FLOW_JOBS` jobs: ids are at most a few hundred bytes. */
export const FLOW_ACTION_BODY_BYTES = 1_048_576;

export const toFlowRequest = (body: FlowActionBody): FlowActionRequest => ({
  action: body.action,
  jobs: body.jobs,
  ...(body.parent === undefined ? {} : { parent: body.parent }),
});

/** 400 `confirmation_required` unless `confirm` is exactly the root id of the flow. */
export function requireFlowConfirmation(root: string, confirm: string | undefined): void {
  if (confirm === root) return;
  throw new ApiError(
    400,
    'confirmation_required',
    'removing a flow deletes its jobs for good: send "confirm" with the flow root id to proceed',
    { required: 'confirm', equals: 'the flow root id' }
  );
}

const MAX_LISTED_IDS = 50;
const some = (ids: readonly string[]) => ids.slice(0, MAX_LISTED_IDS);

/**
 * Why an action did nothing, as the answer: every refusal is a 409 (or a 404) with its own code, and
 * the flow is as it was. The ids it lists are cut, so a refusal of a large flow stays small.
 */
export function refusalToApiError(refusal: FlowRefusal): ApiError {
  switch (refusal.kind) {
    case 'not_found':
      return new ApiError(404, 'flow_not_found', 'no flow has this root');
    case 'too_large':
      return new ApiError(
        409,
        'flow_too_large',
        'the flow has more jobs than one action reads, so nothing was changed',
        { limit: refusal.limit }
      );
    case 'unseen':
      return new ApiError(
        409,
        'flow_changed',
        'the flow has jobs the request did not name: it changed since it was read, so nothing was changed',
        { reason: 'unseen', ids: some(refusal.ids), count: refusal.ids.length }
      );
    case 'foreign':
      return new ApiError(
        409,
        'flow_changed',
        'the request names jobs the action does not apply to or that left the flow, so nothing was changed',
        { reason: 'foreign', ids: some(refusal.ids), count: refusal.ids.length }
      );
    case 'active':
      return new ApiError(
        409,
        'flow_active',
        'jobs of the flow are running: wait for them, or let their leases run out, then remove it',
        { ids: some(refusal.ids), count: refusal.ids.length }
      );
    case 'not_retryable':
      return new ApiError(
        409,
        'flow_not_retryable',
        'only a failed child that holds a waiting parent back can be retried',
        { ids: some(refusal.ids), count: refusal.ids.length }
      );
    case 'not_stuck':
      return new ApiError(409, 'flow_not_stuck', notStuckMessage[refusal.reason], {
        reason: refusal.reason,
        ids: some(refusal.ids),
        count: refusal.ids.length,
      });
  }
}

const notStuckMessage = {
  not_waiting: 'the parent is not waiting for its children, so there is nothing to release',
  nothing_blocks: 'no failed child holds the parent back, so there is nothing to release',
  children_unfinished:
    'children that are not failed have not finished: the parent is released when they have',
} as const;
