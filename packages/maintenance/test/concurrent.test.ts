import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import {
  claimOne,
  expireLease,
  readJob,
  recording,
  resetTables,
} from '../../store-postgres/test/finishHelpers';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { enqueueN, openTestStore } from '../../store-postgres/test/storeHelpers';
import { RecordingTransport, ticker } from './support';

const MINUTE = 60_000;
const CRONS = 12;
const INTERVAL = 5_000;

describeDb('maintenance tick: concurrent ticks are safe', () => {
  const log = recording();
  let t: TestStore;
  let transport: RecordingTransport;
  beforeAll(async () => {
    t = await openTestStore({ recorder: log.recorder, ringWindowMs: 3_600_000, poolSize: 8 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    await t.fresh.sql`TRUNCATE qcloud_tick_state, qcloud_crons, qcloud_workers`;
    log.events.length = 0;
    transport = new RecordingTransport({ clock: t.clock });
  });

  /** Four processes, as four stores with their own pools on one schema. */
  const four = () =>
    [t.store, t.another(), t.another(), t.another()].map((store) =>
      ticker(store, transport, { intervalMs: INTERVAL, ringGraceMs: 0 })
    );
  const count = async (table: string): Promise<number> =>
    Number(
      (await t.fresh.sql<{ n: string }[]>`SELECT count(*) AS n FROM ${t.fresh.sql(table)}`)[0]!.n
    );

  test('a cron occurrence yields one job across four concurrent ticks, round after round', async () => {
    await Promise.all(
      Array.from({ length: CRONS }, (_, n) =>
        t.store.crons.upsert({
          name: `c${n}`,
          queue: 'cq',
          repeatEvery: MINUTE,
          preventOverlap: false,
          data: n,
        })
      )
    );
    for (let round = 1; round <= 4; round += 1) {
      t.clock.advance(MINUTE);
      const runs = await Promise.all(four().map((tick) => tick.run()));
      expect(runs.reduce((sum, run) => sum + run.cronFired, 0)).toBe(CRONS);
      expect(await count('qcloud_jobs')).toBe(CRONS * round);
      expect((await t.store.crons.list()).map((cron) => cron.executions)).toEqual(
        Array(CRONS).fill(round)
      );
    }
  });

  test('four concurrent ticks recover a dead worker once and do not double-count the attempt', async () => {
    const dead = await claimOne(t, { attempts: 3, backoff: 0 });
    // A claim does not count an attempt; the recovery of its lease does, and must do so once.
    expect((await readJob(t, dead.id))?.attempts).toBe(0);
    expireLease(t, dead, 1);
    const runs = await Promise.all(four().map((tick) => tick.run()));
    expect(runs.reduce((sum, run) => sum + run.recovered, 0)).toBe(1);
    const job = await readJob(t, dead.id);
    expect(job).toMatchObject({ state: 'waiting', attempts: 1 });
    expect(log.events.filter((event) => event.type === 'stalled')).toHaveLength(1);
  });

  test('four concurrent ticks promote and expire each job once', async () => {
    await enqueueN(t.store, 25, { delay: 500 });
    const ttl = await enqueueN(t.store, 5);
    await t.fresh.sql`UPDATE qcloud_jobs SET ttl = 100 WHERE id IN ${t.fresh.sql(ttl)}`;
    t.clock.advance(500);
    const runs = await Promise.all(four().map((tick) => tick.run()));
    expect(runs.reduce((sum, run) => sum + run.promoted, 0)).toBe(25);
    expect(runs.reduce((sum, run) => sum + run.expired, 0)).toBe(5);
    expect(await count('qcloud_jobs')).toBe(25);
  });

  test('overlapping ticks may ring a job twice but record it once, and the bells stay fungible', async () => {
    const ids = await enqueueN(t.store, 20);
    const runs = await Promise.all(four().map((tick) => tick.run()));
    expect(runs.every((run) => run.ok)).toBe(true);
    // Every job got at least one bell. A second bell from a racing tick is the cost of not locking.
    const rung = new Set(transport.attempts.map((attempt) => attempt.jobId));
    expect([...rung].sort()).toEqual([...ids].sort());
    const rows = await t.fresh.sql<{ n: string }[]>`
      SELECT count(*) AS n FROM qcloud_jobs WHERE rung_at IS NOT NULL`;
    expect(Number(rows[0]!.n)).toBe(20);
    // And the extra bells cost nothing: one claim per job, whatever the number of bells.
    const claimed = new Set<string>();
    for (let n = 0; n < transport.attempts.length + 5; n += 1) {
      for (const job of await t.store.claim('q', `w${n}`, 1)) claimed.add(job.id);
    }
    expect(claimed.size).toBe(20);
  });
});
