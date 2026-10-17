/**
 * The job format lives in `packages/core` (`workflowStepJob`). The maintenance tick and the Control API
 * publish `wf:step` jobs without importing the engine; the SDK consumes them. This keeps the SDK's
 * own aliases and the jobs it publishes equal to the shared definition: the same job name, queue
 * default, payload fields and options.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  DEFAULT_WORKFLOW_QUEUE,
  noTelemetry,
  resolveWorkflowConfig,
  sweepWorkflows,
  WORKFLOW_STEP_JOB,
} from '../../packages/maintenance/src';
import type { StepJobData } from '../../packages/sdk/src/workflow';
import { DEFAULT_QUEUE_NAME } from '../../packages/sdk/src/workflow/engine';
import { enqueueWorkflowStep, STEP_JOB } from '../../packages/sdk/src/workflow/executorQueue';
import type { SdkFixture } from '../../packages/sdk/test/support';
import { openFixture, resetFixture } from '../../packages/sdk/test/support';
import { codec } from '../../packages/store-postgres/test/finishHelpers';
import { describeDb } from '../support/db';

test('the tick and the engine agree on the job name and the default queue', () => {
  expect(WORKFLOW_STEP_JOB).toBe(STEP_JOB);
  expect(DEFAULT_WORKFLOW_QUEUE).toBe(DEFAULT_QUEUE_NAME);
});

describeDb('the job the tick publishes is the job the engine publishes', () => {
  let f: SdkFixture;
  beforeAll(async () => {
    f = await openFixture();
  });
  afterAll(async () => {
    await f.drop();
  });

  async function envelopes() {
    const rows = await f.fresh.sql<Array<{ payload: Uint8Array }>>`
      SELECT payload FROM qcloud_jobs ORDER BY created_at, id`;
    return rows.map(
      (row) =>
        codec.decode(row.payload) as {
          name: string;
          data: Record<string, unknown>;
          removeOnComplete?: boolean;
        }
    );
  }

  test("same name, same options, and a payload that is the engine's plus the tick's flags", async () => {
    await resetFixture(f);
    const queue = f.queue<StepJobData>(DEFAULT_QUEUE_NAME, {
      defaultJobOptions: { removeOnComplete: true },
    });
    const now = Date.now();
    const exec = {
      id: 'e1',
      workflowName: 'order',
      state: 'running' as const,
      input: {},
      steps: {},
      currentNodeIndex: 3,
      signals: {},
      createdAt: now,
      updatedAt: now,
    };
    await enqueueWorkflowStep(queue, exec, () => {});

    await f.store.workflows.save({ ...exec, id: 'e2' });
    const config = resolveWorkflowConfig({ idleMs: 1 })!;
    await Bun.sleep(20);
    const swept = await sweepWorkflows(
      { store: f.store, transport: f.transport, telemetry: noTelemetry },
      config
    );
    expect(swept.recovered).toBeGreaterThanOrEqual(1);

    const [engine, tick] = await envelopes();
    expect(tick?.name).toBe(engine?.name);
    expect(tick?.removeOnComplete).toBe(engine?.removeOnComplete);
    const { due: _due, recover: _recover, ...tickFields } = tick!.data;
    expect(Object.keys(tickFields).sort()).toEqual(Object.keys(engine!.data).sort());
    expect(engine?.data).toEqual({ executionId: 'e1', workflowName: 'order', nodeIndex: 3 });
  });
});
