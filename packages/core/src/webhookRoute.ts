/**
 * Routes (DESIGN.md D11): a webhook is a route from one queue's job events to a destination. A `queue`
 * route adds a job to another queue of the namespace, and the event that job makes can match the next
 * route. Loops are refused when a route is saved, so there is nothing to count while jobs run.
 */

export const WEBHOOK_DESTINATIONS = ['http', 'queue'] as const;
export type WebhookDestination = (typeof WEBHOOK_DESTINATIONS)[number];

export const isWebhookDestination = (value: unknown): value is WebhookDestination =>
  typeof value === 'string' && (WEBHOOK_DESTINATIONS as readonly string[]).includes(value);

/** Most saved destinations a namespace keeps (the same cap as webhooks). */
export const MAX_DESTINATIONS = 100;

/** Most routes in a chain: queue route feeding queue route, counted in routes. */
export const MAX_ROUTE_CHAIN = 5;

/**
 * The id of the job a `queue` route's delivery adds. It is made from the delivery id, so a repeated
 * attempt finds that job and adds no second one, and a reader can name the job from the delivery.
 * A job's id is up to 256 characters; a delivery id is a number, so this always fits.
 */
export const routeJobId = (deliveryId: string): string => `qcloud-route-${deliveryId}`;

/** A `queue` route as the check sees it: from the queue it listens to, to the queue it adds jobs to. */
export interface RouteEdge {
  readonly from: string;
  readonly to: string;
}

/**
 * What is wrong with these routes taken together: `cycle` (a queue's jobs would end up adding jobs to
 * that queue; a route from a queue to itself is one) or `chain` (the longest run of routes is over
 * `MAX_ROUTE_CHAIN`), else null. A cycle is reported before a chain.
 */
export function routeProblem(edges: readonly RouteEdge[]): 'cycle' | 'chain' | null {
  const next = new Map<string, string[]>();
  for (const { from, to } of edges) next.set(from, [...(next.get(from) ?? []), to]);
  // Routes on the longest path that starts at the queue; -1 while it is being walked (a back edge is a cycle).
  const longest = new Map<string, number>();
  const walk = (queue: string): number => {
    const known = longest.get(queue);
    if (known === -1) return Infinity;
    if (known !== undefined) return known;
    longest.set(queue, -1);
    let best = 0;
    for (const to of next.get(queue) ?? []) best = Math.max(best, 1 + walk(to));
    longest.set(queue, best);
    return best;
  };
  let deepest = 0;
  for (const queue of next.keys()) deepest = Math.max(deepest, walk(queue));
  if (deepest === Infinity) return 'cycle';
  return deepest > MAX_ROUTE_CHAIN ? 'chain' : null;
}
