import { DEFAULT_FLOW_VIEW_NODES } from '@qelay-cloud/core';
import { ApiError } from '../errors';
import type { Route } from '../http/router';
import type { JobsContext } from '../jobs/context';
import {
  FLOW_ACTION_BODY_BYTES,
  flowActionBody,
  flowListQuery,
  flowViewQuery,
  refusalToApiError,
  requireFlowConfirmation,
  toFlowRequest,
} from '../jobs/flowModel';
import { ringAfterCommit } from '../jobs/ring';

/**
 * Flows: the roots of the namespace, one flow as a list of jobs, and what an operator can do to it.
 *
 * - `GET /flows` pages the roots, newest first, each with its jobs counted by state and how many
 *   failed children hold a parent back (`blocked`).
 * - `GET /flows/:id` lists the jobs of the flow whose root is `:id`, top level first, at most `limit`
 *   (default 1,000, at most 5,000). `truncated: true` says there are more than are listed; `total`
 *   is how many there are. Each job carries its `version`, for the action below.
 * - `POST /flows/:id/actions` is `retry-failed`, `promote` or `remove`. The body names every job the
 *   action touches with the version it was read at, so the action is applied to the picture the
 *   caller saw or not at all: a job that moved is 409 `version_conflict`, a flow that grew is 409
 *   `flow_changed`, and any other reason for doing nothing is a 409 of its own (see `flowModel.ts`).
 *   One call is one transaction, so there is never a half-applied action. `remove` takes `confirm`
 *   with the root id. Like every write it needs the `operator` role and is audited, and the entry
 *   names the action.
 *
 * Nothing here creates a flow: a flow is added by the SDK's `FlowProducer`.
 */
export function flowRoutes(ctx: JobsContext): Route[] {
  const { store, config } = ctx;

  return [
    {
      method: 'GET',
      path: '/flows',
      access: 'read',
      async handle(context) {
        const query = context.query(flowListQuery);
        const limit = Math.min(query.limit ?? config.defaultPageSize, config.maxPageSize);
        const offset = query.offset ?? 0;
        if (offset > config.maxOffset) {
          throw new ApiError(400, 'offset_too_large', 'offset is past what a list walks', {
            maxOffset: config.maxOffset,
          });
        }
        const page = await store.flows.roots({ limit, offset });
        return { ok: true, flows: page.items, total: page.total, limit, offset };
      },
    },
    {
      method: 'GET',
      path: '/flows/:id',
      access: 'read',
      async handle(context) {
        const id = context.params.id!;
        const query = context.query(flowViewQuery);
        const view = await store.flows.view(id, { limit: query.limit ?? DEFAULT_FLOW_VIEW_NODES });
        if (view === null) throw refusalToApiError({ kind: 'not_found' });
        return { ok: true, flow: view };
      },
    },
    {
      method: 'POST',
      path: '/flows/:id/actions',
      access: 'write',
      maxBodyBytes: FLOW_ACTION_BODY_BYTES,
      async handle(context) {
        const id = context.params.id!;
        const body = await context.json(flowActionBody);
        context.audit(`flowAction=${body.action}`);
        if (body.action === 'remove') requireFlowConfirmation(id, body.confirm);
        const result = await store.flows.act(id, toFlowRequest(body));
        if (!result.applied) throw refusalToApiError(result.refusal);
        await ringAfterCommit(store, ctx.transport, ctx.logger, result.rings);
        return { ok: true, action: body.action, changes: result.changes };
      },
    },
  ];
}
