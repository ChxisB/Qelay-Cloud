import { MAX_ROUTE_CHAIN, routeProblem } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import { RouteChainError, RouteCycleError } from '../errors';
import type { StoreContext } from './context';

/**
 * Refuses a route set that loops or chains past `MAX_ROUTE_CHAIN` (D11), which rolls the caller's
 * transaction back. Every `queue` route of the namespace counts, enabled or not, the one just
 * written included. The caller holds the namespace's `webhooks` advisory lock, so two saves cannot
 * make a loop between them.
 */
export async function assertRoutesAcyclic(tx: TransactionSQL, ctx: StoreContext): Promise<void> {
  const rows = await tx<Array<{ queue: string; target: string }>>`
    SELECT queue, target FROM qcloud_webhooks
    WHERE namespace = ${ctx.namespace} AND destination = 'queue'`;
  const problem = routeProblem(rows.map((row) => ({ from: row.queue, to: row.target })));
  if (problem === 'cycle') throw new RouteCycleError();
  if (problem === 'chain') throw new RouteChainError(MAX_ROUTE_CHAIN);
}
