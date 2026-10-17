import { afterAll, beforeAll, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { PostgresStore } from '../src/postgresStore';
import { noopRecorder } from '../src/store/events';
import type { JournalEvent } from '../src/store/journal';
import { JOURNAL_START } from '../src/store/journal';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore } from './storeHelpers';

const JOBS = Number(process.env.QCLOUD_JOURNAL_COST_JOBS ?? 5_000);
const CLAIMERS = 8;

/**
 * Gate item (k): what the journal costs the broker-less claim path. Eight claimers drain `JOBS`
 * jobs, claiming four at a time and completing each, once with the recorder switched off and once
 * with the journal. The journal takes a per-namespace lock when an event-writing transaction
 * commits, so its cost shows where claimers commit at once. The test prints both timings and asserts
 * correctness only: a timing bound would be a flaky test.
 */
describeDb('event journal: the cost of the claim path', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ poolSize: CLAIMERS, leaseMs: 30_000 });
  });
  afterAll(async () => {
    await t.drop();
  });

  async function drain(
    store: PostgresStore,
    queue: string
  ): Promise<{ ms: number; owners: number }> {
    const started = performance.now();
    const owners = new Set<string>();
    const work = async (index: number): Promise<void> => {
      const owner = `claimer-${index}`;
      for (;;) {
        const claimed = await store.claim(queue, owner, 4);
        if (claimed.length === 0) {
          // SKIP LOCKED can come back empty while another claimer holds the last rows.
          if ((await store.counts(queue)).waiting === 0) return;
          await Bun.sleep(5);
          continue;
        }
        owners.add(owner);
        for (const job of claimed) await store.complete(job.lease, { echo: job.data });
      }
    };
    await Promise.all(Array.from({ length: CLAIMERS }, (_, index) => work(index)));
    return { ms: performance.now() - started, owners: owners.size };
  }

  test(`${CLAIMERS} claimers drain ${JOBS} jobs with the journal off and on`, async () => {
    const off = t.another({ recorder: noopRecorder });
    const on = t.another();

    let started = performance.now();
    await enqueueN(off, JOBS, {}, 'off');
    const offEnqueueMs = performance.now() - started;
    const offRun = await drain(off, 'off');

    started = performance.now();
    await enqueueN(on, JOBS, {}, 'on');
    const onEnqueueMs = performance.now() - started;
    const onRun = await drain(on, 'on');

    expect(await off.counts('off')).toMatchObject({ completed: JOBS, waiting: 0, active: 0 });
    expect(await on.counts('on')).toMatchObject({ completed: JOBS, waiting: 0, active: 0 });
    expect(offRun.owners).toBeGreaterThan(1);
    expect(onRun.owners).toBeGreaterThan(1);

    // The journal holds three events per job, and a reader following commit order sees each job's
    // events in the order they happened, however the claimers' commits interleaved.
    const seen = new Map<string, string[]>();
    let cursor = JOURNAL_START;
    for (;;) {
      const page = await on.events.read(cursor, { limit: 5_000, queue: 'on' });
      expect(page.gap).toBe(false);
      for (const event of page.events as readonly JournalEvent[]) {
        seen.set(event.jobId, [...(seen.get(event.jobId) ?? []), event.type]);
      }
      cursor = page.cursor;
      if (!page.more) break;
    }
    expect(seen.size).toBe(JOBS);
    expect(
      [...seen.values()].filter((types) => types.join() !== 'pushed,pulled,completed')
    ).toEqual([]);
    const [unsequenced] = await t.fresh.sql<[{ n: number }]>`
      SELECT count(*)::int AS n FROM qcloud_event_commits WHERE commit_seq IS NULL`;
    expect(unsequenced.n).toBe(0);
    const [off0] = await t.fresh.sql<[{ n: number }]>`
      SELECT count(*)::int AS n FROM qcloud_events WHERE queue = 'off'`;
    expect(off0.n).toBe(0);

    const perJob = (ms: number) => (ms / JOBS).toFixed(2);
    console.log(
      `[journal cost] ${JOBS} jobs, ${CLAIMERS} claimers. journal off: enqueue ${offEnqueueMs.toFixed(0)} ms, ` +
        `claim+complete ${offRun.ms.toFixed(0)} ms (${perJob(offRun.ms)} ms/job). ` +
        `journal on: enqueue ${onEnqueueMs.toFixed(0)} ms, claim+complete ${onRun.ms.toFixed(0)} ms ` +
        `(${perJob(onRun.ms)} ms/job); ${(onRun.ms / offRun.ms).toFixed(2)}x`
    );
  }, 300_000);
});
