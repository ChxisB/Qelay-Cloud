import type { Json } from './shared';

/** The one flow of the demo: an order whose notification failed, so the shipment's parent is stuck. */
export const DEMO_FLOW_ROOT = 'flow-order-9a3f';

interface DemoFlowJob {
  id: string;
  name: string;
  queue: string;
  state: string;
  parentId: string | null;
  priority: number;
  attempts: number;
  version: number;
  depth: number;
  /** A failed child that holds its parent back. */
  blocking?: boolean;
  error?: string;
}

const CREATED_AT = Date.parse('2026-03-14T17:20:00Z');

const JOBS: DemoFlowJob[] = [
  {
    id: DEMO_FLOW_ROOT,
    name: 'process-order',
    queue: 'orders',
    state: 'waiting-children',
    parentId: null,
    priority: 1,
    attempts: 0,
    version: 4,
    depth: 0,
  },
  {
    id: 'flow-charge-1',
    name: 'charge-payment',
    queue: 'payments',
    state: 'completed',
    parentId: DEMO_FLOW_ROOT,
    priority: 2,
    attempts: 1,
    version: 3,
    depth: 1,
  },
  {
    id: 'flow-ship-2',
    name: 'ship-order',
    queue: 'shipping',
    state: 'waiting-children',
    parentId: DEMO_FLOW_ROOT,
    priority: 1,
    attempts: 0,
    version: 2,
    depth: 1,
  },
  {
    id: 'flow-label-4',
    name: 'create-label',
    queue: 'shipping',
    state: 'waiting',
    parentId: 'flow-ship-2',
    priority: 0,
    attempts: 0,
    version: 1,
    depth: 2,
  },
  {
    id: 'flow-notify-3',
    name: 'notify-customer',
    queue: 'emails',
    state: 'failed',
    parentId: DEMO_FLOW_ROOT,
    priority: 0,
    attempts: 3,
    version: 5,
    depth: 1,
    blocking: true,
    error: 'SMTP 550: mailbox unavailable',
  },
];

const childrenOf = (id: string): string[] =>
  JOBS.filter((job) => job.parentId === id).map((job) => job.id);

/** The jobs as `GET /jobs/:id` serves them. */
export const DEMO_FLOW: Record<string, Json> = Object.fromEntries(
  JOBS.map((job): [string, Json] => [
    job.id,
    {
      id: job.id,
      queue: job.queue,
      data: { name: job.name },
      state: job.state,
      priority: job.priority,
      parentId: job.parentId,
      childrenIds: childrenOf(job.id),
      flowRoot: DEMO_FLOW_ROOT,
      dependsOn: [],
      attempts: job.attempts,
      ...(job.error ? { failedReason: job.error } : {}),
    },
  ])
);

const nodes = (): Json[] =>
  JOBS.map((job) => ({
    id: job.id,
    queue: job.queue,
    state: job.state,
    version: job.version,
    parentId: job.parentId,
    depth: job.depth,
    attempts: job.attempts,
    createdAt: CREATED_AT,
    completedAt: job.state === 'completed' || job.state === 'failed' ? CREATED_AT + 60_000 : null,
    error: job.error ?? null,
    mode: job.parentId === null ? null : 'fail',
    blocking: job.blocking === true,
    removed: false,
  }));

function states(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const job of JOBS) counts[job.state] = (counts[job.state] ?? 0) + 1;
  return counts;
}

export interface DemoFlowReply {
  status: number;
  body: Json;
}

const notFound = (): DemoFlowReply => ({
  status: 404,
  body: { ok: false, error: 'No flow has this root job.', code: 'flow_not_found' },
});

/**
 * `GET /flows`, `GET /flows/:id` and `POST /flows/:id/actions` for the demo. The demo keeps no state: an
 * action answers as the server would for the one flow, and the next read shows the flow as it was.
 */
export function demoFlowReply(
  segments: string[],
  method: string,
  requestBody?: unknown
): DemoFlowReply {
  if (segments.length === 1 && method === 'GET') {
    return {
      status: 200,
      body: {
        ok: true,
        flows: [
          {
            id: DEMO_FLOW_ROOT,
            queue: 'orders',
            name: 'process-order',
            state: 'waiting-children',
            createdAt: CREATED_AT,
            version: 4,
            total: JOBS.length,
            states: states(),
            blocked: 1,
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
      },
    };
  }
  const id = segments[1] === undefined ? '' : decodeURIComponent(segments[1]);
  if (id !== DEMO_FLOW_ROOT) return notFound();
  if (segments.length === 2 && method === 'GET') {
    return {
      status: 200,
      body: {
        ok: true,
        flow: {
          root: DEMO_FLOW_ROOT,
          nodes: nodes(),
          total: JOBS.length,
          truncated: false,
          limit: 1000,
          failures: [],
        },
      },
    };
  }
  if (segments.length === 3 && segments[2] === 'actions' && method === 'POST')
    return demoAction(requestBody);
  return {
    status: 405,
    body: { ok: false, error: 'Method not allowed', code: 'method_not_allowed' },
  };
}

function demoAction(requestBody: unknown): DemoFlowReply {
  const request = (requestBody ?? {}) as { action?: unknown; jobs?: Array<{ id?: unknown }> };
  const action = request.action;
  if (action !== 'retry-failed' && action !== 'promote' && action !== 'remove') {
    return { status: 400, body: { ok: false, error: 'Unknown flow action', code: 'bad_request' } };
  }
  const touched = JOBS.filter((job) => request.jobs?.some((entry) => entry.id === job.id));
  const to = action === 'retry-failed' ? 'waiting' : action === 'promote' ? 'waiting' : 'removed';
  const changes = touched
    .filter((job) =>
      action === 'retry-failed'
        ? job.state === 'failed'
        : action === 'promote'
          ? job.parentId === null
          : true
    )
    .map((job) => ({ id: job.id, queue: job.queue, from: job.state, to }));
  return { status: 200, body: { ok: true, action, changes } };
}
