import { ApiError } from '../errors';
import type { Route } from '../http/router';
import type { JobsContext } from '../jobs/context';
import { performWorkflowAction } from '../jobs/workflowActions';
import { runFacts } from '../jobs/workflowRules';
import type { WorkflowActionBody } from '../jobs/workflowSchemas';
import {
  WORKFLOW_ACTION_BODY_BYTES,
  workflowActionBody,
  workflowDetailQuery,
  workflowListQuery,
  workflowStepsQuery,
} from '../jobs/workflowSchemas';
import { indexSteps, stepsPage } from '../jobs/workflowSteps';
import { executionDetail, overviews, summaryWire } from '../jobs/workflowView';

/**
 * Workflows: the runs of the namespace and what an operator can do to one. The Control API holds no
 * workflow definition and runs no engine: it reads what the workers recorded (the runs, and the
 * definitions they announced) and publishes jobs for the workers to execute. See `workflowActions.ts`.
 *
 * - `GET /workflows` is the picture: per workflow its run counts by state, its definitions with
 *   whether a worker serves them, and a warning for every definition that live runs are bound to
 *   while no worker serves it; plus one page of runs, newest first, optionally of one workflow or
 *   state (`total` is how many match).
 * - `GET /workflows/executions/:id` is one run: its state, input, the signals it received, the
 *   result of the step that finished last, the definition graph, its children, how far its rollback
 *   got, `actions` (what would be accepted now) and a page of its steps. Payloads are cut to the byte
 *   budgets of the job inspector, with the same truncation markers. A step that fans out (a
 *   `forEach`, a `map`, a loop) is one entry with aggregate counts.
 * - `GET /workflows/executions/:id/steps` pages the steps, or the iterations of one fan-out
 *   (`iterationOf`), or reads one record with the detail budget (`name`).
 * - `POST /workflows/executions/:id/actions` is `signal`, `cancel`, `retry-compensation`,
 *   `abandon-compensation` or `recover`. The body carries the `expectedVersion` the caller read: a
 *   run that moved since is 409 `version_conflict` and nothing changes; a finished run is 409
 *   `execution_terminal`. `cancel` and `abandon-compensation` need `confirm` with the execution id.
 *   Like every write it needs the `operator` role and is audited, and the entry names the action and
 *   the run, never an event, a payload or a reason.
 *
 * Nothing here starts a run or edits a definition: a run is started by the SDK's engine.
 */
export function workflowRoutes(ctx: JobsContext): Route[] {
  const { store, config } = ctx;
  const budgets = { listBytes: config.listPayloadBytes, detailBytes: config.detailPayloadBytes };

  const page = (limit: number | undefined, offset: number | undefined) => {
    const size = Math.min(limit ?? config.defaultPageSize, config.maxPageSize);
    const from = offset ?? 0;
    if (from > config.maxOffset) {
      throw new ApiError(400, 'offset_too_large', 'offset is past what a list walks', {
        maxOffset: config.maxOffset,
      });
    }
    return { limit: size, offset: from };
  };

  const load = async (id: string) => {
    const exec = await store.workflows.get(id);
    if (exec === null) throw new ApiError(404, 'execution_not_found', 'no execution has this id');
    return exec;
  };

  return [
    {
      method: 'GET',
      path: '/workflows',
      access: 'read',
      async handle(context) {
        const query = context.query(workflowListQuery);
        const { limit, offset } = page(query.limit, query.offset);
        const [counts, definitions, live, runs, now] = await Promise.all([
          store.workflows.counts(),
          store.workflows.listDefinitions(query.name === undefined ? {} : { name: query.name }),
          store.workflows.liveDefinitions(),
          store.workflows.summaries({
            limit,
            offset,
            ...(query.name === undefined ? {} : { workflowName: query.name }),
            ...(query.state === undefined ? {} : { state: query.state }),
          }),
          store.workflows.now(),
        ]);
        const total = counts
          .filter(
            (row) =>
              (query.name === undefined || row.workflowName === query.name) &&
              (query.state === undefined || row.state === query.state)
          )
          .reduce((sum, row) => sum + row.count, 0);
        return {
          ok: true,
          workflows: overviews({
            counts,
            definitions,
            live,
            now,
            servedMs: config.workflowServedMs,
            name: query.name,
          }),
          executions: runs.map(summaryWire),
          total,
          limit,
          offset,
          hasMore: offset + runs.length < total,
        };
      },
    },
    {
      method: 'GET',
      path: '/workflows/executions/:id',
      access: 'read',
      async handle(context) {
        const id = context.params.id!;
        const query = context.query(workflowDetailQuery);
        const exec = await load(id);
        const [[summary], definitions, now] = await Promise.all([
          store.workflows.summaries({ id, limit: 1 }),
          store.workflows.listDefinitions({ name: exec.workflowName }),
          store.workflows.now(),
        ]);
        const index = indexSteps(exec.steps);
        return {
          ok: true,
          ...executionDetail({
            exec,
            summary,
            definition: definitions.find((d) => d.hash === exec.definitionHash),
            index,
            steps: stepsPage(index, exec.steps, page(query.limit, query.offset), budgets),
            facts: runFacts(exec, summary?.waitEvent, now, config.workflowIdleMs),
            now,
            servedMs: config.workflowServedMs,
            budgets,
          }),
        };
      },
    },
    {
      method: 'GET',
      path: '/workflows/executions/:id/steps',
      access: 'read',
      async handle(context) {
        const query = context.query(workflowStepsQuery);
        const exec = await load(context.params.id!);
        const select = {
          iterationOf: query.iterationOf,
          name: query.name,
          status: query.status,
          ...page(query.limit, query.offset),
        };
        return { ok: true, steps: stepsPage(indexSteps(exec.steps), exec.steps, select, budgets) };
      },
    },
    {
      method: 'POST',
      path: '/workflows/executions/:id/actions',
      access: 'write',
      maxBodyBytes: WORKFLOW_ACTION_BODY_BYTES,
      async handle(context) {
        const body: WorkflowActionBody = await context.json(workflowActionBody);
        context.audit(`workflowAction=${body.action}`);
        const result = await performWorkflowAction(ctx, context.params.id!, body);
        return { ok: true, ...result };
      },
    },
  ];
}
