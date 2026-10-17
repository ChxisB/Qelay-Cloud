import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { DatabaseOptions, WebhookEnvSettings } from '@qelay-cloud/store-postgres';
import { databaseOptionsFromEnv, webhookSettingsFromEnv } from '@qelay-cloud/store-postgres';
import type { TransportSettings } from '@qelay-cloud/transports';
import { transportSettingsFromEnv } from '@qelay-cloud/transports';
import type { TickOptions } from './config';
import type { WebhookSenderOptions } from './webhookConfig';
import { webhookOptionsFromEnv } from './webhookConfig';
import type { WorkflowSweepOptions } from './workflowSweep';
import { workflowOptionsFromEnv } from './workflowSweep';

/** The scheduler's period when the tick runs as a job or an endpoint: Cloud Scheduler's minute. */
export const SCHEDULED_INTERVAL_MS = 60_000;

type Env = Readonly<Record<string, string | undefined>>;

const NUMBERS: ReadonlyArray<readonly [string, keyof TickOptions]> = [
  ['QCLOUD_TICK_INTERVAL_MS', 'intervalMs'],
  ['QCLOUD_TICK_RE_RING_AFTER_MS', 'reRingAfterMs'],
  ['QCLOUD_TICK_RING_GRACE_MS', 'ringGraceMs'],
  ['QCLOUD_TICK_WORST_LATENESS_MS', 'worstLatenessMs'],
  ['QCLOUD_TICK_RING_WINDOW_MS', 'ringWindowMs'],
  ['QCLOUD_TICK_MAX_RINGS_PER_QUEUE', 'maxRingsPerQueue'],
  ['QCLOUD_TICK_MAX_ITEMS', 'maxItems'],
  ['QCLOUD_TICK_MAX_PASS_MS', 'maxPassMs'],
  ['QCLOUD_TICK_MAX_RUN_MS', 'maxRunMs'],
];

/** The tick's options from the environment. `intervalMs` defaults to the scheduler's period, not the loop's. */
export function tickOptionsFromEnv(env: Env): TickOptions {
  const options: Record<string, number> = { intervalMs: SCHEDULED_INTERVAL_MS };
  for (const [name, key] of NUMBERS) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) {
      throw new UnsupportedOptionError(name, `must be a non-negative integer, not "${raw}"`);
    }
    options[key] = value;
  }
  return options;
}

/** Which broker is `TransportSettings`; the tick adds its namespace, database and options. */
export interface Settings extends TransportSettings {
  readonly namespace: string;
  readonly database: DatabaseOptions;
  readonly tick: TickOptions;
  /** The webhook key and address policy, shared with the Control API, and the sender's own options. */
  readonly webhooks: WebhookEnvSettings & { readonly sender: WebhookSenderOptions };
  /** The workflow step's options: the engine queue, batch, idle window and wait lease. */
  readonly workflows: WorkflowSweepOptions;
}

/**
 * Reads the process settings from the environment. The database URL and every secret come only
 * from here, never from a flag (a flag shows in the process list). Throws `UnsupportedOptionError`
 * naming the variable, and never repeats a value that could be a credential.
 */
export function settingsFromEnv(env: Env): Settings {
  const database = databaseOptionsFromEnv(env, {
    applicationName: 'qcloud-tick',
    purpose: 'the database to tick',
  });
  return {
    namespace: env.QCLOUD_NAMESPACE || 'default',
    ...transportSettingsFromEnv(env),
    database,
    tick: tickOptionsFromEnv(env),
    webhooks: { ...webhookSettingsFromEnv(env), sender: webhookOptionsFromEnv(env) },
    workflows: workflowOptionsFromEnv(env),
  };
}
