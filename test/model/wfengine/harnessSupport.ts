/**
 * Shared pieces of the real-engine model harness: the campaign's migrated schema, the finish test,
 * and a paginated read of every execution.
 */

import type { TickConfig } from '../../../packages/maintenance/src';
import {
  noTelemetry,
  resolveTickConfig,
  resolveWorkflowConfig,
  runTick,
} from '../../../packages/maintenance/src';
import type { Engine, Execution } from '../../../packages/sdk/src';
import type { PostgresStore } from '../../../packages/store-postgres/src';
import { migrate, openDatabase } from '../../../packages/store-postgres/src';
import type { MemoryTransport } from '../../../packages/transport-local/src';
import type { TestSchema } from '../../support/db';
import { createTestSchema, testDatabaseUrl } from '../../support/db';

let shared: Promise<TestSchema> | null = null;
let runs = 0;

/** The next unique namespace: one per generated run, so runs never see each other's rows. */
export function nextNamespace(): string {
  runs += 1;
  return `wfm-${runs}`;
}

export function sharedSchema(): Promise<TestSchema> {
  shared ??= (async () => {
    const created = await createTestSchema();
    const setup = openDatabase({ url: testDatabaseUrl(), schema: created.name, poolSize: 1 });
    try {
      await migrate(setup);
    } finally {
      await setup.close({ timeout: 1000 });
    }
    return created;
  })();
  return shared;
}

/** Drops the campaign's schema. Safe to call when no campaign ever ran. */
export async function disposeCampaign(): Promise<void> {
  const open = shared;
  shared = null;
  if (open) await (await open).drop();
}

/** A run is finished when it is completed, or failed with its rollback's outcome recorded. */
export function finished(exec: Execution): boolean {
  if (exec.state === 'completed') return true;
  return exec.state === 'failed' && exec.rollbackStatus !== undefined;
}

export function operatorRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already being rolled back|not a parked unwind|changed while/.test(message);
}

/** Read every page so lifecycle invariants never silently stop at the default 100 rows. */
export async function listAllExecutions(engine: Engine): Promise<Execution[]> {
  const executions: Execution[] = [];
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const page = await engine.listExecutions(undefined, undefined, { limit, offset });
    executions.push(...page);
    if (page.length < limit) return executions;
  }
}

/**
 * The tick settings of a model run: a pass every few milliseconds, a bell re-rung after 200 ms. The
 * production defaults (5 s) would outlast the harness's own liveness window.
 */
export function modelTickConfig(transport: MemoryTransport, store: PostgresStore): TickConfig {
  return resolveTickConfig(
    transport,
    { intervalMs: 200, reRingAfterMs: 200, ringGraceMs: 50, worstLatenessMs: 100 },
    store
  );
}

/**
 * One pass of the real maintenance tick: the store's tick, the ring step (which is what re-rings a
 * job whose bell a closing worker spent) and the workflow step. A pass that raced the end of the
 * run is simply dropped.
 */
export async function tickOnce(
  store: PostgresStore,
  transport: MemoryTransport,
  config: TickConfig,
  queueName: string,
  idleMs: number
): Promise<void> {
  const workflows = resolveWorkflowConfig({ queueName, idleMs });
  if (workflows === null) return;
  try {
    await runTick({ store, transport, telemetry: noTelemetry, workflows }, config);
  } catch {
    // The next pass, or the dispose, settles it.
  }
}
