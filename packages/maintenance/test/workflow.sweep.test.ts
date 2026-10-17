import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Execution } from '@qelay-cloud/core';
import { ExecutionStaleError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { codec, resetTables } from '../../store-postgres/test/finishHelpers';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import {
  DEFAULT_WORKFLOW_BATCH,
  DEFAULT_WORKFLOW_IDLE_MS,
  DEFAULT_WORKFLOW_QUEUE,
  DEFAULT_WORKFLOW_WAIT_LEASE_MS,
  resolveWorkflowConfig,
  sweepWorkflows,
  workflowOptionsFromEnv,
} from '../src';
import { RecordingTransport, recordedTelemetry, ticker } from './support';

describe('workflow sweep settings', () => {
  test('the defaults, and an off switch', () => {
    expect(resolveWorkflowConfig({})).toEqual({
      queueName: DEFAULT_WORKFLOW_QUEUE,
      batch: DEFAULT_WORKFLOW_BATCH,
      idleMs: DEFAULT_WORKFLOW_IDLE_MS,
      waitLeaseMs: DEFAULT_WORKFLOW_WAIT_LEASE_MS,
    });
    expect(resolveWorkflowConfig({ batch: 0 })).toBeNull();
  });

  test('a setting that is not a positive integer is refused by name', () => {
    expect(() => resolveWorkflowConfig({ idleMs: 0 })).toThrow(/workflow idleMs/);
    expect(() => resolveWorkflowConfig({ batch: 1.5 })).toThrow(/workflow batch/);
    expect(() => resolveWorkflowConfig({ waitLeaseMs: -1 })).toThrow(/workflow waitLeaseMs/);
    expect(() => resolveWorkflowConfig({ queueName: '' })).toThrow(/workflow queueName/);
    expect(() => resolveWorkflowConfig({ queueName: 'a\0b' })).toThrow(/workflow queueName/);
  });

  test('the environment sets them, and a bad value names its variable', () => {
    expect(
      workflowOptionsFromEnv({
        QCLOUD_WORKFLOW_BATCH: '7',
        QCLOUD_WORKFLOW_IDLE_MS: '60000',
        QCLOUD_WORKFLOW_WAIT_LEASE_MS: '5000',
        QCLOUD_WORKFLOW_QUEUE: 'flows',
      })
    ).toEqual({ batch: 7, idleMs: 60000, waitLeaseMs: 5000, queueName: 'flows' });
    expect(workflowOptionsFromEnv({ QCLOUD_WORKFLOW_BATCH: '' })).toEqual({});
    expect(() => workflowOptionsFromEnv({ QCLOUD_WORKFLOW_IDLE_MS: '-5' })).toThrow(
      /QCLOUD_WORKFLOW_IDLE_MS/
    );
    expect(() => workflowOptionsFromEnv({ QCLOUD_WORKFLOW_BATCH: 'many' })).toThrow(
      /QCLOUD_WORKFLOW_BATCH/
    );
  });
});

describeDb('workflow sweep: waits that ran out and runs that stopped moving', () => {
  let t: TestStore;
  let transport: RecordingTransport;
  beforeAll(async () => {
    t = await openTestStore({ ringWindowMs: 3_600_000, poolSize: 4 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    await t.fresh.sql`TRUNCATE qcloud_workflow_executions`;
    transport = new RecordingTransport({ clock: t.clock });
  });

  const IDLE = 10_000;
  const config = (extra = {}) => resolveWorkflowConfig({ idleMs: IDLE, ...extra })!;
  const run = (telemetry = recordedTelemetry(), store = t.store, extra = {}) =>
    sweepWorkflows({ store, transport, telemetry }, config(extra));

  async function seed(id: string, overrides: Partial<Execution> = {}): Promise<void> {
    const now = t.clock.now();
    await t.store.workflows.save({
      id,
      workflowName: 'order',
      state: 'running',
      input: {},
      steps: {},
      currentNodeIndex: 1,
      signals: {},
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
  }

  /** The jobs the sweep published, oldest first, as the worker would decode them. */
  async function published() {
    const rows = await t.fresh.sql<Array<{ queue: string; payload: Uint8Array }>>`
      SELECT queue, payload FROM qcloud_jobs ORDER BY created_at, id`;
    return rows.map((row) => {
      const envelope = codec.decode(row.payload) as {
        name: string;
        data: Record<string, unknown>;
        removeOnComplete?: boolean;
      };
      return { name: envelope.name, queue: row.queue, data: envelope.data };
    });
  }

  test('an overdue wait is published once for its worker to expire, and again after the lease', async () => {
    await seed('w1');
    await t.store.workflows.parkForSignal('w1', 'approved', t.clock.now() + 1_000);
    expect((await run()).due).toBe(0);

    t.clock.advance(2_000);
    const first = await run();
    expect([first.due, first.recovered, first.errors]).toEqual([1, 0, 0]);
    expect(await published()).toEqual([
      {
        name: 'wf:step',
        queue: DEFAULT_WORKFLOW_QUEUE,
        data: { executionId: 'w1', workflowName: 'order', nodeIndex: 1, due: true },
      },
    ]);
    expect(transport.attempts.map((attempt) => attempt.queue)).toEqual([DEFAULT_WORKFLOW_QUEUE]);

    expect((await run()).due).toBe(0);
    t.clock.advance(DEFAULT_WORKFLOW_WAIT_LEASE_MS + 1);
    expect((await run()).due).toBe(1);
  });

  test('a wait without a deadline is never swept, however old', async () => {
    await seed('w1');
    await t.store.workflows.parkForSignal('w1', 'approved');
    t.clock.advance(10 * IDLE);
    const result = await run();
    expect([result.due, result.recovered]).toEqual([0, 0]);
    expect(await published()).toEqual([]);
  });

  test('a running run that went quiet is taken and published once', async () => {
    await seed('r1');
    t.clock.advance(IDLE - 1);
    expect((await run()).recovered).toBe(0);

    t.clock.advance(2);
    const first = await run();
    expect([first.due, first.recovered, first.errors]).toEqual([0, 1, 0]);
    expect((await published()).map((job) => job.data)).toEqual([
      { executionId: 'r1', workflowName: 'order', nodeIndex: 1 },
    ]);
    // The take wrote the row, so it is no longer quiet.
    expect((await run()).recovered).toBe(0);
    t.clock.advance(IDLE + 1);
    expect((await run()).recovered).toBe(1);
  });

  test('a rollback that was owed is published as a recovery, a parked or finished run is left alone', async () => {
    await seed('c1', { state: 'compensating', failureReason: 'boom' });
    await seed('f1', { state: 'failed', failureReason: 'boom' });
    await seed('f2', { state: 'failed', failureReason: 'boom', rollbackStatus: 'completed' });
    await seed('d1', { state: 'completed' });
    await seed('p1');
    await t.store.workflows.parkForSignal('p1', 'go');
    t.clock.advance(IDLE + 1);

    const result = await run();
    expect([result.recovered, result.errors]).toEqual([2, 0]);
    const jobs = (await published()).map((job) => job.data);
    expect(jobs.map((data) => data.executionId).sort()).toEqual(['c1', 'f1']);
    for (const data of jobs) expect(data.recover).toBe(true);
  });

  test('a sub-workflow child is left to its parent', async () => {
    await seed('parent');
    await seed('child', { workflowName: 'inner', parentExecutionId: 'parent' });
    t.clock.advance(IDLE + 1);
    await run();
    expect((await published()).map((job) => job.data.executionId)).toEqual(['parent']);
  });

  test('one pass handles at most batch of each kind and says there is more', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      await seed(`w-${id}`);
      await t.store.workflows.parkForSignal(`w-${id}`, 'go', t.clock.now() + 100);
    }
    t.clock.advance(1_000);
    const result = await run(undefined, t.store, { batch: 2 });
    expect(result.due).toBe(2);
    expect(result.moreWork).toBe(true);
    expect((await run(undefined, t.store, { batch: 100 })).due).toBe(3);
  });

  test('a take that loses to another writer publishes nothing', async () => {
    await seed('r1');
    t.clock.advance(IDLE + 1);
    const losing = new Proxy(t.store.workflows, {
      get(target, prop) {
        if (prop === 'update') {
          return async () => {
            throw new ExecutionStaleError('r1', 0, 1);
          };
        }
        return Reflect.get(target, prop, target);
      },
    });
    const store = Object.assign(Object.create(t.store), { workflows: losing });
    const result = await run(undefined, store);
    expect([result.recovered, result.errors]).toEqual([0, 0]);
    expect(await published()).toEqual([]);
  });

  test('a store that fails is counted and reported, and the pass does not throw', async () => {
    const telemetry = recordedTelemetry();
    const broken = new Proxy(t.store.workflows, {
      get(target, prop) {
        if (prop === 'claimDueWaits') {
          return async () => {
            throw new Error('connection reset');
          };
        }
        return Reflect.get(target, prop, target);
      },
    });
    const store = Object.assign(Object.create(t.store), { workflows: broken });
    const result = await run(telemetry, store);
    expect([result.due, result.recovered, result.errors]).toEqual([0, 0, 1]);
    expect(telemetry.errors.map(([step]) => step)).toEqual(['workflows']);
  });

  test('a wait claimed before a later query failed is still published', async () => {
    await seed('w1');
    await t.store.workflows.parkForSignal('w1', 'go', t.clock.now() + 100);
    t.clock.advance(1_000);
    const half = new Proxy(t.store.workflows, {
      get(target, prop) {
        if (prop === 'listRecoverable') {
          return async () => {
            throw new Error('statement timeout');
          };
        }
        return Reflect.get(target, prop, target);
      },
    });
    const store = Object.assign(Object.create(t.store), { workflows: half });
    const result = await run(undefined, store);
    expect([result.due, result.errors]).toEqual([1, 1]);
    expect((await published()).map((job) => job.data.executionId)).toEqual(['w1']);
  });

  test('a tick pass runs the step and reports it; without the config it does nothing', async () => {
    await seed('w1');
    await t.store.workflows.parkForSignal('w1', 'go', t.clock.now() + 100);
    t.clock.advance(1_000);
    const off = ticker(t.store, transport, { intervalMs: 5_000 });
    expect((await off.pass()).workflows).toEqual({ due: 0, recovered: 0, errors: 0 });

    const on = ticker(t.store, transport, { intervalMs: 5_000 }, undefined, undefined, config());
    expect((await on.pass()).workflows).toEqual({ due: 1, recovered: 0, errors: 0 });
    expect((await published()).map((job) => job.name)).toEqual(['wf:step']);
  });
});
