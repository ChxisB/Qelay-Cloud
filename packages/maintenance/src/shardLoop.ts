import type { Database, PostgresStore } from '@qelay-cloud/store-postgres';
import { openDatabase } from '@qelay-cloud/store-postgres';
import type { Settings } from './env';
import { TickLoop } from './loop';
import type { Telemetry } from './telemetry';
import type { TickDeps } from './tick';
import { resolveWebhookConfig } from './webhookConfig';
import { resolveWorkflowConfig } from './workflowSweep';

/** The store and the broker of one namespace: what a tick runs against. */
export interface TickRuntime {
  readonly store: PostgresStore;
  readonly transport: TickDeps['transport'] & { close?(): Promise<void> };
}

/** What every tick of the process shares: the runtime, the telemetry, and the webhook and workflow steps the settings turn on. */
export function tickDeps(runtime: TickRuntime, settings: Settings, telemetry: Telemetry): TickDeps {
  const webhooks = resolveWebhookConfig(settings.webhooks.sender, settings.webhooks.urlPolicy);
  const workflows = resolveWorkflowConfig(settings.workflows);
  return {
    store: runtime.store,
    transport: runtime.transport,
    telemetry,
    ...(webhooks === null ? {} : { webhooks: { config: webhooks } }),
    ...(workflows === null ? {} : { workflows }),
  };
}

/**
 * One `TickLoop` for each namespace of a shard, over one pool: the pool is the budget's per-process
 * count, so a shard's namespaces share it. The lease is per namespace, so another process serving the
 * same shard follows each loop and takes over each on its own. Runs until `stop` aborts, then gives
 * every lease up and closes the pool.
 *
 * shortcut: the loops beat independently on one event loop and one pool, so a shard with hundreds of
 * busy namespaces wants several processes (give each its own `QCLOUD_SHARDS`), not one.
 */
export async function runShardLoop(
  settings: Settings & { readonly shard: readonly string[] },
  open: (settings: Settings, db: Database) => TickRuntime,
  telemetry: Telemetry,
  io: { err(line: string): void },
  stop: AbortSignal | undefined
): Promise<void> {
  const db = openDatabase(settings.database);
  const runtimes: TickRuntime[] = [];
  try {
    const loops = settings.shard.map((namespace) => {
      const runtime = open({ ...settings, namespace }, db);
      runtimes.push(runtime);
      return new TickLoop(tickDeps(runtime, settings, telemetry), settings.tick);
    });
    for (const loop of loops) loop.start();
    io.err(
      JSON.stringify({
        level: 'info',
        message: 'ticking',
        namespaces: settings.shard.length,
        intervalMs: loops[0]?.config.intervalMs,
      })
    );
    await new Promise<void>((resolve) => {
      if (stop?.aborted) resolve();
      stop?.addEventListener('abort', () => resolve(), { once: true });
    });
    await Promise.all(loops.map((loop) => loop.stop()));
  } finally {
    for (const runtime of runtimes) await runtime.transport.close?.().catch(() => {});
    await db.close({ timeout: 5_000 }).catch(() => {});
  }
}
