import { z } from 'zod';

/**
 * `GET /capabilities` of the Control API: what this deployment serves, what it deliberately closes,
 * and who is asking. The server's own type is `CapabilitiesResponse` in `packages/control-api`.
 * Unknown fields are ignored, so a newer server does not break an older panel.
 */
export type PanelRole = 'viewer' | 'operator';

const featuresSchema = z.object({
  dlq: z.boolean(),
  cron: z.boolean(),
  flows: z.boolean(),
  workflows: z.boolean(),
  webhooks: z.boolean(),
});
export type FeatureFlags = z.infer<typeof featuresSchema>;

const capabilitiesSchema = z.object({
  transport: z.object({
    name: z.string(),
    maxDeliverDelayMs: z.number().nullable(),
    ordering: z.string(),
  }),
  features: featuresSchema,
  hidden: z.array(z.string()),
  unsupported: z.array(z.string()),
  principal: z.object({ role: z.enum(['viewer', 'operator']) }),
  version: z.string(),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

export class CapabilitiesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilitiesError';
  }
}

/** A body that is not a capabilities document is an error: the panel does not guess. */
export function parseCapabilities(value: unknown): Capabilities {
  const parsed = capabilitiesSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CapabilitiesError(
      `The server's /capabilities answer is not understood (at "${issue.path.join('.') || 'body'}").`
    );
  }
  return parsed.data;
}

/**
 * What the panel assumes until the server has answered, and after it failed to: the pages that
 * need a server concept or an optional feature are closed, and the caller is a viewer. Closed is
 * the safe side to be wrong on; the page opens when the answer arrives.
 */
export const FAIL_CLOSED: Capabilities = Object.freeze({
  transport: { name: 'unknown', maxDeliverDelayMs: null, ordering: 'none' },
  features: { dlq: false, cron: false, flows: false, workflows: false, webhooks: false },
  hidden: ['serverControl', 'sqliteDatabase', 's3Backup', 'fleet', 'queueOperations'],
  unsupported: [],
  principal: { role: 'viewer' as const },
  version: 'unknown',
});

/** Demo mode serves canned data for every page, as an operator. */
export const DEMO_CAPABILITIES: Capabilities = Object.freeze({
  transport: { name: 'demo', maxDeliverDelayMs: null, ordering: 'none' },
  features: { dlq: true, cron: true, flows: true, workflows: true, webhooks: true },
  hidden: [],
  unsupported: [],
  principal: { role: 'operator' as const },
  version: 'demo',
});
