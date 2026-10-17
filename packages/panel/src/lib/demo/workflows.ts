import type { Json } from './shared';
import {
  DEMO_NOW,
  FAN_OUT_ITEMS,
  FAN_OUT_STEP,
  fanOutIteration,
  seedRuns,
  type DemoRun,
} from './workflowData';

/**
 * The demo's Control API for workflows: the same wire as `docs/openapi.yaml`, over a handful of runs
 * kept in memory, so the page, its filters, the fan-out drill-down and every action work without a server.
 * An action changes the demo run (and its `version`) the way the real one would, and refuses a stale
 * `version` or a finished run with the same codes.
 */

export interface DemoWorkflowReply {
  status: number;
  body: Json;
}

let runs = seedRuns();

/** Puts the demo back to its starting point (used by tests). */
export function resetDemoWorkflows(): void {
  runs = seedRuns();
}

const failure = (
  status: number,
  code: string,
  error: string,
  details?: Json
): DemoWorkflowReply => ({
  status,
  body: { ok: false, error, code, ...(details ? { details } : {}) },
});

const ACTIONS = ['signal', 'cancel', 'retry-compensation', 'abandon-compensation', 'recover'];

function actionsFor(run: DemoRun): string[] {
  switch (run.state) {
    case 'running':
    case 'waiting':
      return ['signal', 'cancel'];
    case 'compensation-stuck':
      return ['retry-compensation', 'abandon-compensation'];
    default:
      return [];
  }
}

const summary = (run: DemoRun): Json => ({
  id: run.id,
  workflowName: run.workflowName,
  state: run.state,
  definitionHash: run.definitionHash,
  parentExecutionId: run.parentExecutionId,
  currentNodeIndex: run.currentNodeIndex,
  rollbackStatus: run.rollbackStatus,
  failureReason: run.failureReason,
  committedAt: run.committedAt,
  version: run.version,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  wait: run.wait,
});

const page = (query: URLSearchParams, fallback: number) => {
  const limit = Math.min(Math.max(Number(query.get('limit')) || fallback, 1), 100);
  const offset = Math.max(Number(query.get('offset')) || 0, 0);
  return { limit, offset };
};

function overview(): Json[] {
  const names = [...new Set(runs.map((run) => run.workflowName))].sort();
  return names.map((name) => {
    const own = runs.filter((run) => run.workflowName === name);
    const counts: Record<string, number> = {};
    for (const run of own) counts[run.state] = (counts[run.state] ?? 0) + 1;
    const hashes = [...new Set(own.map((run) => run.definitionHash).filter(Boolean))] as string[];
    return {
      name,
      total: own.length,
      counts,
      warnings: [],
      definitions: hashes.map((hash) => ({
        hash,
        revision: hash.slice(7, 15),
        nodes: own.find((run) => run.definitionHash === hash)?.graph.length ?? 0,
        firstSeenAt: DEMO_NOW - 864_000_000,
        lastSeenAt: DEMO_NOW - 30_000,
        served: true,
        liveRuns: own.filter(
          (run) => run.definitionHash === hash && !['completed', 'failed'].includes(run.state)
        ).length,
      })),
    };
  });
}

function list(query: URLSearchParams): DemoWorkflowReply {
  const name = query.get('name');
  const state = query.get('state');
  const matching = runs
    .filter((run) => (!name || run.workflowName === name) && (!state || run.state === state))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const { limit, offset } = page(query, 25);
  const items = matching.slice(offset, offset + limit);
  return {
    status: 200,
    body: {
      ok: true,
      workflows: overview(),
      executions: items.map(summary),
      total: matching.length,
      limit,
      offset,
      hasMore: offset + items.length < matching.length,
    },
  };
}

function stepsPage(run: DemoRun, query: URLSearchParams): Json {
  const { limit, offset } = page(query, 50);
  const base = query.get('iterationOf');
  const status = query.get('status');
  if (base === FAN_OUT_STEP) {
    const matching: number[] = [];
    for (let index = 0; index < FAN_OUT_ITEMS; index++) {
      if (!status || fanOutIteration(index).status === status) matching.push(index);
    }
    const items = matching.slice(offset, offset + limit).map(fanOutIteration);
    return {
      items,
      total: matching.length,
      limit,
      offset,
      hasMore: offset + items.length < matching.length,
    };
  }
  const own = base ? [] : run.steps.filter((item) => !status || item.status === status);
  const items = own.slice(offset, offset + limit);
  return { items, total: own.length, limit, offset, hasMore: offset + items.length < own.length };
}

function detail(run: DemoRun, query: URLSearchParams): DemoWorkflowReply {
  const definition = run.definitionHash
    ? {
        hash: run.definitionHash,
        revision: run.definitionHash.slice(7, 15),
        graph: run.graph,
        firstSeenAt: DEMO_NOW - 864_000_000,
        lastSeenAt: DEMO_NOW - 30_000,
        served: true,
      }
    : null;
  return {
    status: 200,
    body: {
      ok: true,
      execution: {
        ...summary(run),
        input: run.input,
        signals: { total: run.signals.length, items: run.signals },
        output: run.output,
        actions: actionsFor(run),
      },
      definition,
      steps: stepsPage(run, query),
      children: { total: run.children.length, items: run.children },
      compensation: run.compensation,
    },
  };
}

function act(run: DemoRun, body: Record<string, unknown>): DemoWorkflowReply {
  const action = String(body.action);
  if (!ACTIONS.includes(action)) return failure(400, 'bad_request', 'Unknown workflow action');
  if (run.state === 'completed' || (run.state === 'failed' && run.rollbackStatus !== null)) {
    return failure(409, 'execution_terminal', 'the execution has finished, so nothing applies', {
      state: run.state,
      ...(run.rollbackStatus ? { rollbackStatus: run.rollbackStatus } : {}),
    });
  }
  if (body.expectedVersion !== run.version) {
    return failure(
      409,
      'version_conflict',
      'the execution changed since it was read, so nothing was changed',
      {
        expectedVersion: body.expectedVersion ?? null,
        actualVersion: run.version,
      }
    );
  }
  if (!actionsFor(run).includes(action)) {
    return failure(
      409,
      'execution_state',
      `${action} does not apply to a run that is ${run.state}`,
      {
        state: run.state,
        allowed: actionsFor(run),
      }
    );
  }
  if ((action === 'cancel' || action === 'abandon-compensation') && body.confirm !== run.id) {
    return failure(400, 'confirmation_required', 'type the execution id to confirm');
  }
  if (action === 'signal') {
    run.signals.push({
      event: String(body.event),
      ...(body.payload === undefined ? {} : { payload: body.payload }),
    });
    if (run.wait?.event === body.event) {
      run.state = 'running';
      run.wait = null;
      run.currentNodeIndex += 1;
    }
  } else if (action === 'cancel') {
    run.state = 'failed';
    run.rollbackStatus = 'completed';
    run.failureReason =
      typeof body.reason === 'string'
        ? `Cancelled by an operator: ${body.reason}`
        : 'Cancelled by an operator';
    run.wait = null;
  } else if (action === 'retry-compensation') {
    run.state = 'failed';
    run.rollbackStatus = 'completed';
    run.compensation = {
      ...run.compensation,
      status: 'completed',
      compensated: run.compensation.eligible,
      failed: 0,
      failures: [],
    };
  } else if (action === 'abandon-compensation') {
    run.state = 'failed';
    run.rollbackStatus = 'abandoned';
  }
  run.version += 1;
  run.updatedAt = DEMO_NOW;
  return {
    status: 200,
    body: {
      ok: true,
      action,
      executionId: run.id,
      published: action !== 'signal',
      version: run.version,
    },
  };
}

/** `GET/POST /workflows…` as the demo answers it. `segments` start at `workflows`. */
export function demoWorkflowReply(
  segments: string[],
  method: string,
  search: string,
  body?: unknown
): DemoWorkflowReply {
  const query = new URLSearchParams(search);
  if (segments.length === 1) {
    return method === 'GET'
      ? list(query)
      : failure(405, 'method_not_allowed', 'Method not allowed');
  }
  if (segments[1] !== 'executions' || !segments[2]) return failure(404, 'not_found', 'Not found');
  const run = runs.find((item) => item.id === decodeURIComponent(segments[2]));
  if (!run) return failure(404, 'execution_not_found', 'No workflow execution has this id');
  const leaf = segments[3];
  if (!leaf && method === 'GET') return detail(run, query);
  if (leaf === 'steps' && method === 'GET')
    return { status: 200, body: { ok: true, steps: stepsPage(run, query) } };
  if (leaf === 'actions' && method === 'POST') {
    return act(run, body && typeof body === 'object' ? (body as Record<string, unknown>) : {});
  }
  return failure(405, 'method_not_allowed', 'Method not allowed');
}
