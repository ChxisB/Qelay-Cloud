import { afterAll, beforeAll, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { PostgresStore } from '../src/postgresStore';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore } from './storeHelpers';
import { addHook, KEY } from './webhookHelpers';

const JOBS = Number(process.env.QCLOUD_WEBHOOK_COST_JOBS ?? 2_000);
const CLAIMERS = 8;
const HOOKS = 3;

/**
 * What the delivery trigger costs the job path. Three webhooks are registered, all for `hooked`
 * (pushed, started, completed) and none for `bare`; eight claimers push, claim and complete `JOBS`
 * jobs in each queue. The trigger runs for every event of both, and inserts rows only for `hooked`.
 * The test prints both timings and asserts correctness only: a timing bound would be a flaky test.
 */
describeDb('webhooks: the cost of the delivery trigger on the job path', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ webhookKey: KEY, poolSize: CLAIMERS, leaseMs: 30_000 });
  });
  afterAll(async () => {
    await t.drop();
  });

  async function drain(store: PostgresStore, queue: string): Promise<number> {
    const started = performance.now();
    const work = async (index: number): Promise<void> => {
      for (;;) {
        const claimed = await store.claim(queue, `claimer-${index}`, 4);
        if (claimed.length === 0) {
          if ((await store.counts(queue)).waiting === 0) return;
          await Bun.sleep(5);
          continue;
        }
        for (const job of claimed) await store.complete(job.lease, 'ok');
      }
    };
    await Promise.all(Array.from({ length: CLAIMERS }, (_, index) => work(index)));
    return performance.now() - started;
  }

  test(`${JOBS} jobs with and without ${HOOKS} webhooks subscribed to their queue`, async () => {
    for (let i = 0; i < HOOKS; i++) {
      await addHook(t, { queue: 'hooked', events: ['job.pushed', 'job.started', 'job.completed'] });
    }
    const timings: Record<string, { enqueue: number; run: number }> = {};
    for (const queue of ['bare', 'hooked']) {
      const started = performance.now();
      await enqueueN(t.store, JOBS, {}, queue);
      const enqueue = performance.now() - started;
      timings[queue] = { enqueue, run: await drain(t.store, queue) };
    }
    const [rows] = await t.fresh.sql<[{ hooked: number; bare: number }]>`
      SELECT count(*) FILTER (WHERE queue = 'hooked')::int AS hooked,
             count(*) FILTER (WHERE queue = 'bare')::int AS bare
      FROM qcloud_webhook_deliveries`;
    expect(rows.bare).toBe(0);
    expect(rows.hooked).toBe(JOBS * 3 * HOOKS);
    const per = (ms: number) => (ms / JOBS).toFixed(2);
    const { bare, hooked } = timings as Record<'bare' | 'hooked', { enqueue: number; run: number }>;
    console.log(
      `[webhook cost] ${JOBS} jobs, ${CLAIMERS} claimers, ${HOOKS} webhooks on one queue. ` +
        `no delivery rows: enqueue ${bare.enqueue.toFixed(0)} ms, claim+complete ${bare.run.toFixed(0)} ms ` +
        `(${per(bare.run)} ms/job). ${HOOKS * 3} delivery rows per job: enqueue ${hooked.enqueue.toFixed(0)} ms, ` +
        `claim+complete ${hooked.run.toFixed(0)} ms (${per(hooked.run)} ms/job); ` +
        `${(hooked.run / bare.run).toFixed(2)}x claim+complete, ${(hooked.enqueue / bare.enqueue).toFixed(2)}x enqueue`
    );
  }, 300_000);
});
