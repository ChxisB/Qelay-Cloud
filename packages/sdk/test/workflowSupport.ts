import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test';
import type { Execution, ExecutionState, WorkflowStepJob } from '@qelay-cloud/core';
import { DEFAULT_WORKFLOW_QUEUE, workflowStepJob } from '@qelay-cloud/core';
import { testDatabaseUrl } from '../../../test/support/db';
import type { WorkflowSweepOptions } from '../../maintenance/src';
import {
  noTelemetry,
  resolveTickConfig,
  resolveWorkflowConfig,
  ringDue,
  runTick,
  sweepWorkflows,
} from '../../maintenance/src';
import type { EngineOptions } from '../src';
import { Engine } from '../src';
import type { SdkFixture } from './support';
import { NAMESPACE, openFixture, resetFixture } from './support';
import { until } from './workerSupport';

/**
 * Opens `Engine`s on the fixture's schema and namespace, as separate processes would, and closes
 * them all. A `MemoryTransport` moves bells only when ticked, so the kit ticks it while an engine
 * is open, which is what a broker's clock does for a delayed bell.
 */
export function workflowKit(fixture: () => SdkFixture) {
  const open: Engine[] = [];
  let ticker: ReturnType<typeof setInterval> | null = null;
  return {
    engine(extra: Partial<EngineOptions> = {}): Engine {
      const f = fixture();
      const own: Partial<EngineOptions> =
        extra.store === undefined
          ? {
              databaseUrl: testDatabaseUrl(),
              database: { schema: f.fresh.name, poolSize: 3 },
              namespace: NAMESPACE,
            }
          : {};
      const engine = new Engine({ transport: f.transport, ...own, ...extra } as EngineOptions);
      open.push(engine);
      ticker ??= setInterval(() => fixture().transport.tick(), 10);
      return engine;
    },
    /** One workflow pass of the maintenance tick: expire overdue waits, take stuck runs. */
    async sweep(options: WorkflowSweepOptions = {}) {
      const f = fixture();
      const config = resolveWorkflowConfig({ idleMs: 1, ...options });
      if (config === null) throw new Error('the sweep is off');
      return await sweepWorkflows(
        { store: f.store, transport: f.transport, telemetry: noTelemetry },
        config
      );
    },
    /**
     * One full pass of the maintenance tick (the store's tick, the ring step, the workflow step) with
     * a short re-ring window. A job whose bell a force-closed worker spent waits for it.
     */
    async tick(options: WorkflowSweepOptions = {}) {
      const f = fixture();
      const config = resolveTickConfig(
        f.transport,
        { intervalMs: 200, reRingAfterMs: 200, ringGraceMs: 50, worstLatenessMs: 100 },
        f.store
      );
      const workflows = resolveWorkflowConfig({ idleMs: 1, ...options });
      if (workflows === null) throw new Error('the sweep is off');
      return await runTick(
        { store: f.store, transport: f.transport, telemetry: noTelemetry, workflows },
        config
      );
    },
    /**
     * Publish a `wf:step` job the way the Control API does: no workflow definition, just the store
     * and the doorbell.
     */
    async publishStep(step: WorkflowStepJob, queue = DEFAULT_WORKFLOW_QUEUE) {
      const f = fixture();
      const admitted = await f.store.enqueue([workflowStepJob(queue, step)]);
      await ringDue(
        { store: f.store, transport: f.transport, telemetry: noTelemetry },
        admitted.flatMap((job) => (job.ring === null ? [] : [job.ring]))
      );
    },
    async closeAll(force = true): Promise<void> {
      if (ticker !== null) clearInterval(ticker);
      ticker = null;
      await Promise.all(open.splice(0).map((engine) => engine.close(force).catch(() => {})));
    },
  };
}

/** Polls the run until it is in one of `states`. */
export async function untilState(
  engine: Engine,
  id: string,
  states: ExecutionState | readonly ExecutionState[],
  ms = 8000
): Promise<Execution> {
  const wanted = new Set<ExecutionState>(Array.isArray(states) ? states : [states]);
  let last: Execution | null = null;
  try {
    return await until(
      `run ${id} to be ${[...wanted].join(' or ')}`,
      async () => {
        last = await engine.getExecution(id);
        return last !== null && wanted.has(last.state) ? last : null;
      },
      ms
    );
  } catch (error) {
    const seen = last as Execution | null;
    throw new Error(
      `${(error as Error).message} (it is ${seen?.state ?? 'missing'}, node ${seen?.currentNodeIndex ?? '?'}, ${seen?.failureReason ?? 'no failure reason'})`
    );
  }
}

/**
 * Registers the hooks every workflow suite shares (call it inside a `describeDb`): one schema per
 * file, the execution table emptied before each test, and every engine the test opened closed after.
 */
export function useWorkflowKit() {
  let f: SdkFixture;
  const kit = workflowKit(() => f);
  beforeAll(async () => {
    f = await openFixture();
  });
  afterAll(async () => {
    await f.drop();
  });
  beforeEach(async () => {
    await resetFixture(f);
    await f.fresh.sql`TRUNCATE qcloud_workflow_executions`;
  });
  afterEach(() => kit.closeAll());
  return { kit, fixture: () => f };
}
