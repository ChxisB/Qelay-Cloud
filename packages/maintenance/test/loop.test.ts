import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { PostgresStore } from '@qelay-cloud/store-postgres';
import { describeDb } from '../../../test/support/db';
import {
  claimOne,
  expireLease,
  readJob,
  resetTables,
} from '../../store-postgres/test/finishHelpers';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { enqueueN, openTestStore } from '../../store-postgres/test/storeHelpers';
import { TickLoop } from '../src/loop';
import type { TickLoopOptions } from '../src/loop';
import { RecordingTransport, recordedTelemetry } from './support';

const INTERVAL = 5_000;
const LEASE = 3 * INTERVAL;

async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('TickLoop configuration', () => {
  const store = { ringWindowMs: 0 } as unknown as PostgresStore;
  const transport = new RecordingTransport();
  const make = (options: TickLoopOptions) => new TickLoop({ store, transport }, options);

  test('a re-ring age above the interval is rejected when the loop is built', () => {
    expect(() => make({ intervalMs: 500, reRingAfterMs: 501 })).toThrow(UnsupportedOptionError);
    expect(() => make({ intervalMs: 500, reRingAfterMs: 501 })).toThrow(/reRingAfterMs/);
  });

  test('a lease shorter than two intervals is rejected: one late beat would hand the lead over', () => {
    expect(() => make({ intervalMs: 500, leaseMs: 999 })).toThrow(/leaseMs.*two tick intervals/);
    expect(make({ intervalMs: 500, leaseMs: 1_000 }).leaseMs).toBe(1_000);
    expect(make({ intervalMs: 500 }).leaseMs).toBe(1_500);
  });

  test('each loop has its own holder name by default, and an empty one is refused', () => {
    expect(make({}).holder).not.toBe(make({}).holder);
    expect(() => make({ holder: '' })).toThrow(/holder/);
  });
});

describeDb('TickLoop: leader election on the database clock', () => {
  let t: TestStore;
  let transport: RecordingTransport;
  const loops: TickLoop[] = [];
  beforeAll(async () => {
    t = await openTestStore({ ringWindowMs: 3_600_000, poolSize: 8 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    await t.fresh.sql`TRUNCATE qcloud_tick_state, qcloud_crons, qcloud_workers`;
    transport = new RecordingTransport({ clock: t.clock });
  });

  const loop = (holder: string, options: TickLoopOptions = {}, telemetry = recordedTelemetry()) => {
    const made = new TickLoop(
      { store: t.another(), transport, telemetry },
      { intervalMs: INTERVAL, ringGraceMs: 0, holder, ...options }
    );
    loops.push(made);
    return made;
  };

  test('with four processes beating at once, exactly one leads and runs the tick', async () => {
    await enqueueN(t.store, 3);
    const racers = ['a', 'b', 'c', 'd'].map((holder) => loop(holder));
    const reports = await Promise.all(racers.map((racer) => racer.beat()));
    expect(reports.filter((report) => report !== null)).toHaveLength(1);
    expect(racers.filter((racer) => racer.leading)).toHaveLength(1);
    expect(racers.reduce((sum, racer) => sum + racer.stats.led, 0)).toBe(1);
    expect(racers.reduce((sum, racer) => sum + racer.stats.followed, 0)).toBe(3);
  });

  test('the leader keeps the lead by renewing, however long the others wait', async () => {
    const [a, b] = [loop('a'), loop('b')] as [TickLoop, TickLoop];
    await a.beat();
    for (let n = 0; n < 6; n += 1) {
      t.clock.advance(INTERVAL);
      expect(await a.beat()).not.toBeNull();
      expect(await b.beat()).toBeNull();
    }
    expect(a.leading).toBe(true);
    expect(b.leading).toBe(false);
  });

  test("a follower takes over once the dead leader's lease has run out, and not before", async () => {
    const [a, b] = [loop('a'), loop('b')] as [TickLoop, TickLoop];
    await a.beat();
    t.clock.advance(LEASE - 1);
    expect(await b.beat()).toBeNull();
    t.clock.advance(1);
    expect(await b.beat()).not.toBeNull();
    expect(b.leading).toBe(true);
    // The old leader, back from its pause, finds it has been replaced and does not tick.
    expect(await a.beat()).toBeNull();
    expect(a.leading).toBe(false);
  });

  test('a leader that stops gives the lease up, so a follower leads on its next beat', async () => {
    const [a, b] = [loop('a'), loop('b')] as [TickLoop, TickLoop];
    a.start();
    await until(() => a.leading);
    await a.stop();
    expect(await b.beat()).not.toBeNull();
    expect(b.leading).toBe(true);
  });

  test('two ticks overlapping during a takeover change nothing a single tick would not', async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, n) =>
        t.store.crons.upsert({
          name: `c${n}`,
          queue: 'cq',
          repeatEvery: 60_000,
          preventOverlap: false,
          data: n,
        })
      )
    );
    const dead = await claimOne(t, { attempts: 3, backoff: 0 });
    await enqueueN(t.store, 5, { delay: 100 }, 'late');
    // The lease has run out, and so has the cron's minute.
    expireLease(t, dead, 1);
    t.clock.advance(60_000);

    const [a, b] = [loop('a'), loop('b')] as [TickLoop, TickLoop];
    const release = transport.holdNext();
    const slow = a.beat();
    await until(() => transport.attempts.length > 0);
    // `a` is inside its ring step, past the work that mutates. Its lease runs out meanwhile.
    t.clock.advance(LEASE + 1);
    const takeover = await b.beat();
    expect(takeover).toMatchObject({ ok: true });
    release();
    expect(await slow).toMatchObject({ ok: true });

    const rows = await t.fresh.sql<
      { n: string }[]
    >`SELECT count(*) AS n FROM qcloud_jobs WHERE queue = 'cq'`;
    expect(Number(rows[0]!.n)).toBe(6);
    expect((await t.store.crons.list()).map((cron) => cron.executions)).toEqual(Array(6).fill(1));
    expect(await readJob(t, dead.id)).toMatchObject({ state: 'waiting', attempts: 1 });
    const unrung = await t.fresh.sql<
      { n: string }[]
    >`SELECT count(*) AS n FROM qcloud_jobs WHERE rung_at IS NULL`;
    expect(Number(unrung[0]!.n)).toBe(0);
    // `b` leads now, and `a` follows.
    expect(await a.beat()).toBeNull();
    expect(b.leading).toBe(true);
  });

  test('a beat that finds the database failing reports it and does not throw, then recovers', async () => {
    const telemetry = recordedTelemetry();
    const broken = new TickLoop(
      {
        store: Object.assign(Object.create(t.another()) as PostgresStore, {
          maintenance: {
            acquireTickLease: async () => {
              throw new Error('database down');
            },
          },
        }),
        transport,
        telemetry,
      },
      { intervalMs: INTERVAL }
    );
    expect(await broken.beat()).toBeNull();
    expect(broken.stats).toMatchObject({ beats: 1, failed: 1, led: 0 });
    expect(telemetry.errors.map(([step]) => step)).toEqual(['loop']);
    expect(broken.leading).toBe(false);
  });
});
