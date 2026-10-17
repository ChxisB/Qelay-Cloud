import { z } from 'zod';

/**
 * What the Control API says about workflow executions (`GET /workflows`, `GET /workflows/executions/:id`,
 * `GET /workflows/executions/:id/steps`, `POST /workflows/executions/:id/actions`; `docs/openapi.yaml` is
 * the contract). Every run carries the `version` an action must quote back, so a picture that went stale
 * is refused by the server and never acted on.
 */
export const WORKFLOW_STATES = [
  'running',
  'waiting',
  'compensating',
  'compensation-stuck',
  'failed',
  'completed',
] as const;
export const WORKFLOW_ACTIONS = [
  'signal',
  'cancel',
  'retry-compensation',
  'abandon-compensation',
  'recover',
] as const;
export type WorkflowActionName = (typeof WORKFLOW_ACTIONS)[number];

const count = z.number().int().min(0);
const nullableText = z.string().nullable();

const waitSchema = z.object({ event: z.string(), deadlineAt: z.number().nullable() });

const summarySchema = z.object({
  id: z.string().min(1),
  workflowName: z.string(),
  // A state this panel does not know is shown as it came, not refused.
  state: z.string(),
  definitionHash: nullableText,
  parentExecutionId: nullableText,
  currentNodeIndex: count,
  rollbackStatus: nullableText,
  failureReason: nullableText,
  committedAt: z.number().nullable(),
  version: count,
  createdAt: z.number(),
  updatedAt: z.number(),
  wait: waitSchema.nullable(),
});

const definitionSchema = z.object({
  hash: z.string(),
  revision: z.string(),
  nodes: count,
  firstSeenAt: z.number(),
  lastSeenAt: z.number(),
  served: z.boolean(),
  liveRuns: count,
});

const warningSchema = z.object({
  code: z.string(),
  workflow: z.string(),
  hash: z.string(),
  runs: count,
  known: z.boolean(),
  lastSeenAt: z.number().nullable(),
  message: z.string(),
});

const overviewSchema = z.object({
  name: z.string(),
  total: count,
  counts: z.record(z.string(), count),
  definitions: z.array(definitionSchema),
  warnings: z.array(warningSchema),
});

const listSchema = z.object({
  workflows: z.array(overviewSchema),
  executions: z.array(summarySchema),
  total: count,
  limit: count,
  offset: count,
  hasMore: z.boolean(),
});

const fanOutSchema = z.object({
  iterations: count,
  byStatus: z.object({ pending: count, running: count, completed: count, failed: count }),
  compensation: z.object({ compensated: count, failed: count, skipped: count }),
});

const stepSchema = z.object({
  name: z.string(),
  status: z.string(),
  attempts: count.nullable(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  compensatable: z.boolean(),
  error: nullableText,
  errorTruncated: z.boolean().optional(),
  result: z.unknown().optional(),
  resultTruncated: z.boolean().optional(),
  childExecutionId: nullableText,
  compensation: z.object({ status: z.string(), at: z.number(), error: nullableText }).nullable(),
  loopIndex: count.nullable(),
  loopItem: z.unknown().optional(),
  loopItemTruncated: z.boolean().optional(),
  fanOut: fanOutSchema.optional(),
});

const stepsPageSchema = z.object({
  items: z.array(stepSchema),
  total: count,
  limit: count,
  offset: count,
  hasMore: z.boolean(),
});

const compensationSchema = z.object({
  status: z.string(),
  eligible: count,
  compensated: count,
  failed: count,
  skipped: count,
  failures: z.array(z.object({ step: z.string(), error: nullableText })),
});

const executionSchema = summarySchema.extend({
  input: z.unknown().optional(),
  inputTruncated: z.boolean().optional(),
  signals: z.object({
    total: count,
    items: z.array(
      z.object({
        event: z.string(),
        payload: z.unknown().optional(),
        truncated: z.boolean().optional(),
      })
    ),
  }),
  output: z
    .object({ step: z.string(), result: z.unknown().optional(), truncated: z.boolean().optional() })
    .nullable(),
  actions: z.array(z.string()),
});

const detailSchema = z.object({
  execution: executionSchema,
  definition: z
    .object({
      hash: z.string(),
      revision: z.string(),
      graph: z.array(z.record(z.string(), z.unknown())),
      firstSeenAt: z.number(),
      lastSeenAt: z.number(),
      served: z.boolean(),
    })
    .nullable(),
  steps: stepsPageSchema,
  children: z.object({
    total: count,
    items: z.array(z.object({ step: z.string(), executionId: z.string() })),
  }),
  compensation: compensationSchema,
});

const resultSchema = z.object({
  action: z.enum(WORKFLOW_ACTIONS),
  executionId: z.string(),
  published: z.boolean(),
  resumed: z.boolean().optional(),
  version: count.nullable(),
});

export type WorkflowSummary = z.infer<typeof summarySchema>;
export type WorkflowDefinition = z.infer<typeof definitionSchema>;
export type WorkflowWarning = z.infer<typeof warningSchema>;
export type WorkflowOverview = z.infer<typeof overviewSchema>;
export type WorkflowList = z.infer<typeof listSchema>;
export type WorkflowFanOut = z.infer<typeof fanOutSchema>;
export type WorkflowStep = z.infer<typeof stepSchema>;
export type WorkflowStepsPage = z.infer<typeof stepsPageSchema>;
export type WorkflowCompensation = z.infer<typeof compensationSchema>;
export type WorkflowExecution = z.infer<typeof executionSchema>;
export type WorkflowDetail = z.infer<typeof detailSchema>;
export type WorkflowActionResult = z.infer<typeof resultSchema>;

/** The server answered, but not with workflow data: a proxy or an older server in the way. */
export class WorkflowPayloadError extends Error {
  constructor(what: string) {
    super(`The server sent a ${what} the panel does not understand.`);
    this.name = 'WorkflowPayloadError';
  }
}

function parse<T>(schema: z.ZodType<T>, what: string, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new WorkflowPayloadError(what);
  return result.data;
}

export const parseWorkflowList = (value: unknown): WorkflowList =>
  parse(listSchema, 'list of workflows', value);
export const parseWorkflowDetail = (value: unknown): WorkflowDetail =>
  parse(detailSchema, 'workflow execution', value);
export const parseWorkflowSteps = (value: unknown): WorkflowStepsPage =>
  parse(stepsPageSchema, 'page of workflow steps', (value as { steps?: unknown } | null)?.steps);
export const parseWorkflowActionResult = (value: unknown): WorkflowActionResult =>
  parse(resultSchema, 'result for the action', value);

/** The body of `POST /workflows/executions/:id/actions`. */
export interface WorkflowActionBody {
  readonly action: WorkflowActionName;
  /** The run's `version` as the operator read it. */
  readonly expectedVersion: number;
  readonly event?: string;
  readonly payload?: unknown;
  readonly reason?: string;
  readonly confirm?: string;
}
