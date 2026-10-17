import type { ExecutionState } from '@qelay-cloud/core';
import { EXECUTION_STATES } from '@qelay-cloud/core';
import { z } from 'zod';

const state = z.enum(EXECUTION_STATES as unknown as [ExecutionState, ...ExecutionState[]]);
const page = {
  limit: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(),
};

/** `GET /workflows`: definitions and one page of runs, newest first, optionally of one workflow or state. */
export const workflowListQuery = z.object({
  name: z.string().min(1).max(512).optional(),
  state: state.optional(),
  ...page,
});

/** `GET /workflows/executions/:id`: the page of its steps (see `workflowStepsQuery`). */
export const workflowDetailQuery = z.object(page);

/**
 * `GET /workflows/executions/:id/steps`: the step records, a page at a time. `iterationOf` lists the
 * iterations of one fan-out step (a `forEach`, a `map` or a loop body) in order; `name` reads one
 * record with the larger payload budget of a detail. `status` filters either.
 */
export const workflowStepsQuery = z.object({
  ...page,
  iterationOf: z.string().min(1).max(512).optional(),
  name: z.string().min(1).max(512).optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed']).optional(),
});

export const WORKFLOW_ACTIONS = [
  'signal',
  'cancel',
  'retry-compensation',
  'abandon-compensation',
  'recover',
] as const;

export type WorkflowActionName = (typeof WORKFLOW_ACTIONS)[number];

/** The actions that cannot be taken back: the body must name the run in `confirm`. */
export const DESTRUCTIVE_ACTIONS: readonly WorkflowActionName[] = [
  'cancel',
  'abandon-compensation',
];

/** A signal payload is a small message; the largest body of an action. */
export const WORKFLOW_ACTION_BODY_BYTES = 1_048_576;

/** Longest event name or cancel reason. */
export const MAX_EVENT_CHARS = 256;
export const MAX_REASON_CHARS = 500;

/**
 * `POST /workflows/executions/:id/actions`. Strict, like every action body: a misspelt
 * `expectedVersion` would be dropped and the action would run unfenced. `expectedVersion` is the
 * `version` of the run the caller read, so a run that moved since it was shown is refused and not
 * acted on.
 */
export const workflowActionBody = z.strictObject({
  action: z.enum(WORKFLOW_ACTIONS),
  expectedVersion: z.number().int().min(0),
  /** `signal`: the event a `waitFor` awaits. */
  event: z.string().min(1).max(MAX_EVENT_CHARS).optional(),
  /** `signal`: what the event carries, in the payload form of the job routes (`$type` tags). */
  payload: z.unknown().optional(),
  /** `cancel`: why, kept as the run's failure reason. */
  reason: z.string().min(1).max(MAX_REASON_CHARS).optional(),
  /** `cancel` and `abandon-compensation` take the run id: they cannot be taken back. */
  confirm: z.string().optional(),
});

export type WorkflowActionBody = z.infer<typeof workflowActionBody>;
