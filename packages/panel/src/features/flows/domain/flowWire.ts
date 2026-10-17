import { z } from 'zod';

/**
 * What the Control API says about flows (`GET /flows`, `GET /flows/:id`, `POST /flows/:id/actions`;
 * `docs/openapi.yaml` is the contract). A flow is a list of jobs, each with the `version` an action
 * must quote back, so a picture that went stale is refused by the server and never acted on.
 */
export const FLOW_MODES = ['fail', 'continue', 'ignore', 'remove'] as const;
export const FLOW_ACTIONS = ['retry-failed', 'promote', 'remove'] as const;
export type FlowActionName = (typeof FLOW_ACTIONS)[number];

/** Most jobs `GET /flows/:id` lists, however many the flow has. */
export const MAX_FLOW_VIEW_NODES = 5_000;
/** Jobs it lists when the caller asks for no number. */
export const DEFAULT_FLOW_VIEW_NODES = 1_000;

const state = z.string();
const count = z.number().int().min(0);

const nodeSchema = z.object({
  id: z.string().min(1),
  queue: z.string(),
  state,
  version: count.nullable(),
  parentId: z.string().nullable(),
  depth: count,
  attempts: count,
  createdAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  error: z.string().nullable(),
  mode: z.enum(FLOW_MODES).nullable(),
  blocking: z.boolean(),
  removed: z.boolean(),
});

const failureSchema = z.object({
  parentId: z.string(),
  childId: z.string(),
  queue: z.string(),
  mode: z.enum(['continue', 'ignore']),
  error: z.string(),
});

const viewSchema = z.object({
  root: z.string().min(1),
  nodes: z.array(nodeSchema),
  total: count,
  truncated: z.boolean(),
  limit: count,
  failures: z.array(failureSchema),
});

const rootSchema = z.object({
  id: z.string().min(1),
  queue: z.string(),
  name: z.string().nullable(),
  state,
  createdAt: z.number(),
  version: count,
  total: count,
  states: z.record(z.string(), count),
  blocked: count,
});

const listSchema = z.object({
  flows: z.array(rootSchema),
  total: count,
  limit: count,
  offset: count,
});

const changeSchema = z.object({
  id: z.string(),
  queue: z.string(),
  from: z.string(),
  to: z.string(),
});

const resultSchema = z.object({
  action: z.enum(FLOW_ACTIONS),
  changes: z.array(changeSchema),
});

export type FlowNode = z.infer<typeof nodeSchema>;
export type FlowFailure = z.infer<typeof failureSchema>;
export type FlowView = z.infer<typeof viewSchema>;
export type FlowRootSummary = z.infer<typeof rootSchema>;
export type FlowList = z.infer<typeof listSchema>;
export type FlowChange = z.infer<typeof changeSchema>;
export type FlowActionResult = z.infer<typeof resultSchema>;

/** The server answered, but not with a flow: a proxy or an older server in the way. */
export class FlowPayloadError extends Error {
  constructor(what: string) {
    super(`The server sent a ${what} the panel does not understand.`);
    this.name = 'FlowPayloadError';
  }
}

function parse<T>(schema: z.ZodType<T>, what: string, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new FlowPayloadError(what);
  return result.data;
}

export const parseFlowView = (value: unknown): FlowView =>
  parse(viewSchema, 'flow', (value as { flow?: unknown } | null)?.flow);
export const parseFlowList = (value: unknown): FlowList =>
  parse(listSchema, 'list of flows', value);
export const parseFlowActionResult = (value: unknown): FlowActionResult =>
  parse(resultSchema, 'result for the action', value);

/** One job an action touches, with the version the operator was looking at. */
export interface FlowJobVersion {
  readonly id: string;
  readonly expectedVersion: number;
}

/** The body of `POST /flows/:id/actions`. */
export interface FlowActionBody {
  readonly action: FlowActionName;
  readonly jobs: readonly FlowJobVersion[];
  readonly parent?: string;
  readonly confirm?: string;
}
