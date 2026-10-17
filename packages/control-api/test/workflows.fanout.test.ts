import { expect, test } from 'bun:test';
import type { StepRecord } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { seedRun, useWorkflowApi } from './workflowFixture';

const ITEMS = 10_000;

describeDb('workflow read routes: a for-each over ten thousand items', () => {
  const w = useWorkflowApi();

  test('is one entry with counts, and its iterations are read a page at a time', async () => {
    const f = w.fixture;
    const t0 = f.t.clock.now();
    const steps: Record<string, StepRecord> = { charge: { status: 'completed', startedAt: t0 } };
    steps.notify = { status: 'running', startedAt: t0 + 1 };
    for (let n = 0; n < ITEMS; n++) {
      steps[`notify:${n}`] = {
        status: n % 1_000 === 7 ? 'failed' : n < 9_000 ? 'completed' : 'pending',
        loopIndex: n,
        loopItem: { sku: `sku-${n}` },
        startedAt: t0 + 2 + n,
        ...(n % 1_000 === 7 ? { error: `no stock for sku-${n}` } : {}),
      };
    }
    await seedRun(f, 'w1', { steps });

    const detail = await w.api.call('GET', '/workflows/executions/w1?limit=50');
    expect(detail.status).toBe(200);
    expect(detail.body.steps.total).toBe(2);
    expect(detail.body.steps.items.map((s: { name: string }) => s.name)).toEqual([
      'charge',
      'notify',
    ]);
    expect(detail.body.steps.items[1].fanOut).toEqual({
      iterations: ITEMS,
      byStatus: { pending: 999, running: 0, completed: 8_991, failed: 10 },
      compensation: { compensated: 0, failed: 0, skipped: 0 },
    });
    // The detail names none of the ten thousand: it stays a small answer however long the loop is.
    expect(JSON.stringify(detail.body).length).toBeLessThan(50_000);

    const last = await w.api.call(
      'GET',
      `/workflows/executions/w1/steps?iterationOf=notify&limit=100&offset=${ITEMS - 100}`
    );
    expect(last.body.steps).toMatchObject({ total: ITEMS, limit: 100, hasMore: false });
    expect(last.body.steps.items).toHaveLength(100);
    expect(last.body.steps.items.at(-1)).toMatchObject({ name: `notify:${ITEMS - 1}` });

    const failed = await w.api.call(
      'GET',
      '/workflows/executions/w1/steps?iterationOf=notify&status=failed&limit=25'
    );
    expect(failed.body.steps.total).toBe(10);
    expect(failed.body.steps.items[0]).toMatchObject({ name: 'notify:7', status: 'failed' });
  }, 60_000);
});
