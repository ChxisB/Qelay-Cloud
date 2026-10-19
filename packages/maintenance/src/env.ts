import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { DatabaseOptions, WebhookEnvSettings } from '@qelay-cloud/store-postgres';
import {
  databaseOptionsForNamespace,
  ShardMap,
  webhookSettingsFromEnv,
} from '@qelay-cloud/store-postgres';
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
  ['QCLOUD_TICK_MAX_STALE_RINGS_PER_QUEUE', 'maxStaleRingsPerQueue'],
  ['QCLOUD_TICK_MAX_ITEMS', 'maxItems'],
  ['QCLOUD_TICK_MAX_PASS_MS', 'maxPassMs'],
  ['QCLOUD_TICK_MAX_RUN_MS', 'maxRunMs'],
  ['QCLOUD_TICK_UPKEEP_EVERY_MS', 'upkeepEveryMs'],
];

/**
 * The tick's options from the environment. `defaults` apply where the environment is silent: the
 * scheduler's period for `run` and `serve`, the `loop` command's own for `loop`.
 */
export function tickOptionsFromEnv(
  env: Env,
  defaults: TickOptions = { intervalMs: SCHEDULED_INTERVAL_MS }
): TickOptions {
  const options: Record<string, number> = { ...defaults } as Record<string, number>;
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
  /** With `shard` set, the first namespace of the shard: they all share `database`. */
  readonly namespace: string;
  /** `loop` only (`QCLOUD_SHARD`): every namespace of one shard, which one process ticks over one pool. */
  readonly shard?: readonly string[];
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
export function settingsFromEnv(env: Env, tickDefaults?: TickOptions): Settings {
  const options = { applicationName: 'qcloud-tick', purpose: 'the database to tick' };
  const shardName = env.QCLOUD_SHARD || undefined;
  let namespace = env.QCLOUD_NAMESPACE || 'default';
  let shard: string[] | undefined;
  if (shardName !== undefined) {
    const map = ShardMap.fromEnv(env, options);
    if (map === null) throw new UnsupportedOptionError('QCLOUD_SHARD', 'needs QCLOUD_SHARDS');
    if (env.QCLOUD_NAMESPACE) {
      throw new UnsupportedOptionError(
        'QCLOUD_SHARD',
        'conflicts with QCLOUD_NAMESPACE: choose one'
      );
    }
    shard = map.namespacesOf(shardName);
    if (shard.length === 0) {
      throw new UnsupportedOptionError(
        'QCLOUD_SHARD',
        `"${shardName}" holds no namespace of QCLOUD_SHARDS`
      );
    }
    namespace = shard[0]!;
  }
  return {
    namespace,
    ...(shard === undefined ? {} : { shard }),
    ...transportSettingsFromEnv(env),
    database: databaseOptionsForNamespace(env, namespace, options),
    tick: tickOptionsFromEnv(env, tickDefaults),
    webhooks: { ...webhookSettingsFromEnv(env), sender: webhookOptionsFromEnv(env) },
    workflows: workflowOptionsFromEnv(env),
  };
}
