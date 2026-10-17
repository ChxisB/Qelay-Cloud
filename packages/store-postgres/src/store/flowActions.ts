import type { FlowActionRequest, FlowActionResult } from '@qelay-cloud/core';
import { MAX_FLOW_JOBS, UnsupportedOptionError } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { isFlowRoot, versionsOf } from './flowActionSupport';
import { promoteParent } from './flowPromote';
import { removeFlow } from './flowRemove';
import { retryFailed } from './flowRetry';
import { runTransaction } from './retry';

/**
 * The operator's actions on a flow (`store.flows.act`). One call is one transaction: it checks every
 * job it touches against the version the caller read (`expectedVersion`), decides, then writes, so an
 * action is applied whole or not at all and nothing partial is ever visible. A job whose version moved
 * throws `JobVersionError`; every other reason for doing nothing is a `FlowRefusal` in the result.
 *
 * - `retry-failed`: `flowRetry.ts`. - `promote`: `flowPromote.ts`. - `remove`: `flowRemove.ts`.
 *
 * Rings for jobs the action queued come back in the result for the caller to ring after the commit,
 * as for every store write.
 */
export async function flowAction(
  ctx: StoreContext,
  rootId: string,
  request: FlowActionRequest
): Promise<FlowActionResult> {
  const versions = versionsOf(request.jobs);
  if (versions.size === 0) throw new UnsupportedOptionError('jobs', 'must name at least one job');
  if (versions.size > MAX_FLOW_JOBS) {
    throw new UnsupportedOptionError('jobs', `names more than ${MAX_FLOW_JOBS} jobs`);
  }
  if (request.action === 'promote') {
    if (request.parent === undefined) {
      throw new UnsupportedOptionError('parent', 'is required for promote');
    }
  } else if (request.parent !== undefined) {
    throw new UnsupportedOptionError('parent', `does not apply to ${request.action}`);
  }
  return ctx.db.run('flowAction', (sql) =>
    runTransaction(sql, async (tx): Promise<FlowActionResult> => {
      if (!(await isFlowRoot(tx, ctx.namespace, rootId))) {
        return { applied: false, refusal: { kind: 'not_found' } };
      }
      switch (request.action) {
        case 'retry-failed':
          return retryFailed(ctx, tx, rootId, versions);
        case 'promote':
          return promoteParent(ctx, tx, rootId, request.parent!, versions);
        case 'remove':
          return removeFlow(ctx, tx, rootId, versions);
      }
    })
  );
}
