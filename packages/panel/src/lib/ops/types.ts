import { z } from 'zod';

/**
 * The Control API's `GET /transport`, `GET /transport/dead-letters` and `GET /deployment`. The
 * server's own types are in `packages/control-api/src/opsTypes.ts`. Two rules hold in every
 * response and in every view of it:
 *
 * - `null` is "unknown", never zero. A number the server could not read is shown as unknown.
 * - A figure that comes from a broker says how old it is (`freshness`), because cloud queue metrics
 *   lag by minutes and must not be read as real time.
 *
 * Unknown fields are ignored, so a newer server does not break an older panel.
 */

const count = z.number().int().nullable();
/** A count a server that predates the field does not send: unknown, as it would be on a broker that cannot count it. */
const optionalCount = count.default(null);

const freshnessSchema = z.object({
  observedAt: z.number().nullable(),
  ageMs: z.number().nullable(),
  maxStalenessMs: z.number(),
  source: z.string(),
});
export type Freshness = z.infer<typeof freshnessSchema>;

const storeRowSchema = z.object({
  queue: z.string(),
  claimable: z.number().int(),
  notRung: z.number().int(),
  reRingDue: z.number().int(),
  oldestNotRungAgeMs: z.number().nullable(),
  paused: z.boolean(),
  /** Outside its run window: held on purpose, so not a missing bell. */
  windowClosed: z.boolean(),
  capped: z.boolean(),
});
export type StoreRow = z.infer<typeof storeRowSchema>;

const transportQueueSchema = z.object({
  queue: z.string(),
  doorbellDepth: count,
  inFlight: optionalCount,
  delayed: optionalCount,
  oldestUndeliveredAgeMs: z.number().nullable(),
  deadLetterDepth: count,
  deadLetterOldestAgeMs: z.number().nullable(),
  freshness: freshnessSchema,
  store: storeRowSchema,
});
export type TransportQueue = z.infer<typeof transportQueueSchema>;

const transportSchema = z.object({
  transport: z.object({
    name: z.string(),
    maxDeliverDelayMs: z.number().nullable(),
    ordering: z.string(),
    /** The broker documents its counts as approximate (SQS). A server that predates the field counts exactly. */
    approximateCounts: z.boolean().default(false),
  }),
  deadLetter: z.object({ supported: z.boolean() }),
  queues: z.array(transportQueueSchema),
  truncated: z.boolean(),
  timestamp: z.number(),
});
export type TransportView = z.infer<typeof transportSchema>;

const deadLetterItemSchema = z.object({
  jobId: z.string().nullable(),
  queue: z.string(),
  deliveryCount: z.number().int().nullable(),
  deadLetteredAt: z.number().nullable(),
  ageMs: z.number().nullable(),
  jobExists: z.boolean(),
});
export type DeadLetterItem = z.infer<typeof deadLetterItemSchema>;

const deadLettersSchema = z.object({
  queue: z.string(),
  available: z.boolean(),
  reason: z.enum(['not_supported', 'unreachable']).nullable(),
  items: z.array(deadLetterItemSchema),
  timestamp: z.number(),
});
export type DeadLettersView = z.infer<typeof deadLettersSchema>;

const checkState = z.enum(['ok', 'failed', 'unknown']);
export type CheckState = z.infer<typeof checkState>;
const tickState = z.enum(['ok', 'late', 'stale', 'never', 'unknown']);
export type TickState = z.infer<typeof tickState>;
const schemaState = z.enum(['current', 'behind', 'ahead', 'unknown']);

const warningSchema = z.object({
  code: z.string(),
  severity: z.enum(['warning', 'critical']),
  message: z.string(),
});
export type DeploymentWarning = z.infer<typeof warningSchema>;

const deploymentSchema = z.object({
  version: z.string(),
  commit: z.string().nullable(),
  production: z.boolean(),
  devToken: z.boolean(),
  schema: z.object({
    current: z.number().int().nullable(),
    expected: z.number().int(),
    state: schemaState,
  }),
  database: z.object({ state: checkState, latencyMs: z.number().nullable() }),
  transport: z.object({ name: z.string(), state: checkState }),
  connections: z.object({
    inUse: count,
    maxConnections: count,
    needed: count,
    mode: z.enum(['direct', 'pooled']).nullable(),
  }),
  tick: z.object({
    state: tickState,
    lastSuccessAt: z.number().nullable(),
    lastFailureAt: z.number().nullable(),
    ageMs: z.number().nullable(),
    lateAfterMs: z.number(),
    staleAfterMs: z.number(),
  }),
  workers: z.object({ total: count, active: count }),
  doorbells: z.object({
    notRung: count,
    oldestNotRungAgeMs: z.number().nullable(),
    queuesScanned: count,
    partial: z.boolean(),
  }),
  warnings: z.array(warningSchema),
  timestamp: z.number(),
});
export type DeploymentView = z.infer<typeof deploymentSchema>;

export class OpsParseError extends Error {
  constructor(what: string, path: string) {
    super(`The server's ${what} answer is not understood (at "${path || 'body'}").`);
    this.name = 'OpsParseError';
  }
}

function parse<T>(schema: z.ZodType<T>, what: string, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new OpsParseError(what, parsed.error.issues[0]?.path.join('.') ?? '');
  }
  return parsed.data;
}

/** A body that is not what the page expects is an error: the panel never guesses a number. */
export const parseTransport = (value: unknown): TransportView =>
  parse(transportSchema, '/transport', value);
export const parseDeadLetters = (value: unknown): DeadLettersView =>
  parse(deadLettersSchema, '/transport/dead-letters', value);
export const parseDeployment = (value: unknown): DeploymentView =>
  parse(deploymentSchema, '/deployment', value);
