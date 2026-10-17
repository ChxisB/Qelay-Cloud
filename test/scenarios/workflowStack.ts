import type { Execution, ExecutionState } from '../../packages/core/src';
import type { EngineOptions } from '../../packages/sdk/src';
import { Engine } from '../../packages/sdk/src';
import { testDatabaseUrl } from '../support/db';
import { until } from './scenario';
import type { Stack, StackOptions } from './stack';

/** The queue the engine's node jobs travel on, and so the one a broker must have provisioned. */
export const WORKFLOW_QUEUE = '__wf:steps';

/** Stack settings every workflow scenario shares: the engine queue, and the tick's workflow step on. */
export const workflowStack: StackOptions = {
  queues: [WORKFLOW_QUEUE],
  tickIntervalMs: 150,
  workflows: { idleMs: 1_000, waitLeaseMs: 2_000 },
};

/**
 * Engines on a stack, as separate processes would open them: each on the stack's schema and
 * namespace, with a transport of the stack's kind. `close` ends them all, so a scenario that throws
 * leaves nothing running.
 */
export function workflowEngines(stack: Stack) {
  const open: Engine[] = [];
  const transports: Array<{ close(): Promise<void> }> = [];
  return {
    engine(extra: Partial<EngineOptions> = {}): Engine {
      const transport = extra.transport ?? stack.transport();
      if (stack.kind !== 'memory') transports.push(transport);
      const engine = new Engine({
        databaseUrl: testDatabaseUrl(),
        database: { schema: stack.fresh.name, poolSize: 3 },
        namespace: stack.namespace,
        transport,
        concurrency: 3,
        heartbeatMs: 100,
        recoverIdleMs: 1_000,
        ...extra,
      });
      open.push(engine);
      return engine;
    },
    async close(): Promise<void> {
      await Promise.all(open.splice(0).map((engine) => engine.close(true).catch(() => {})));
      await Promise.all(transports.splice(0).map((transport) => transport.close().catch(() => {})));
    },
  };
}

/** Reads runs straight from the stack's store: no engine, so no worker to take a bell. */
export function runReader(stack: Stack): RunReader {
  return { getExecution: (id) => stack.store.workflows.get(id) };
}

export interface RunReader {
  getExecution(id: string): Promise<Execution | null>;
}

/** Waits until the run is in one of the states, and returns it. */
export async function untilRun(
  engine: RunReader,
  id: string,
  states: ExecutionState | readonly ExecutionState[],
  ms = 30_000
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
