import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
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
import { RecordingTransport, recordedTelemetry, ticker } from './support';

const INTERVAL = 5_000;

describeDb('maintenance tick: one pass and one invocation', () => {
  const log = recording();
  let t: TestStore;
  let transport: RecordingTransport;
  beforeAll(async () => {
    t = await openTestStore({ recorder: log.recorder, ringWindowMs: 3_600_000, poolSize: 6 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    await t.fresh.sql`TRUNCATE qcloud_tick_state, qcloud_crons`;
    log.events.length = 0;
    transport = new RecordingTransport({ clock: t.clock });
  });

  const tick = (options = {}, store = t.store, telemetry?: ReturnType<typeof recordedTelemetry>) =>
    ticker(store, transport, { intervalMs: INTERVAL, ...options }, telemetry);
  const rungAt = async (id: string) => (await readJob(t, id))?.rung_at ?? null;

  /** What the enqueuer does after its commit: ring the bell, report it, and (if `lose`) the broker loses it. */
  async function publish(id: string, queue = 'q', lose = true): Promise<void> {
    if (lose) transport.dropNext(1);
    await transport.ring([{ bell: { namespace: 'test', queue, jobId: id } }]);
    await t.store.markRung([{ jobId: id, deliverAfterMs: 0 }]);
  }

  describe('the bell is repaired, never duplicated early', () => {
    test('a dropped publish is repaired by the first tick after reRingAfterMs', async () => {
      const [id] = await enqueueN(t.store, 1);
      await publish(id!);
      expect(transport.buffered('q').ready).toBe(0);

      t.clock.advance(INTERVAL - 1);
      expect(await tick().pass()).toMatchObject({ ring: { due: 0 } });
      expect(transport.buffered('q').ready).toBe(0);

      t.clock.advance(1);
      const pass = await tick().pass();
      expect(pass.ring).toMatchObject({ due: 1, rung: 1 });
      expect(transport.buffered('q').ready).toBe(1);
      expect(Number(await rungAt(id!))).toBe(t.clock.now());
    });

    test('the bell just rung is not rung again by the next pass', async () => {
      const [id] = await enqueueN(t.store, 1);
      await publish(id!);
      t.clock.advance(INTERVAL);
      expect((await tick().pass()).ring.rung).toBe(1);
      expect((await tick().pass()).ring.due).toBe(0);
      t.clock.advance(INTERVAL);
      expect((await tick().pass()).ring.rung).toBe(1);
    });

    test('a job with no bell yet is left alone inside the grace, and rung at its end', async () => {
      const [id] = await enqueueN(t.store, 1);
      t.clock.advance(1_999);
      expect((await tick().pass()).ring.due).toBe(0);
      t.clock.advance(1);
      expect((await tick().pass()).ring).toMatchObject({ due: 1, rung: 1 });
      expect(await rungAt(id!)).not.toBeNull();
    });

    test('a paused queue is not rung', async () => {
      const [id] = await enqueueN(t.store, 1);
      await t.store.pause('q');
      t.clock.advance(INTERVAL);
      expect((await tick().pass()).ring.due).toBe(0);
      await t.store.resume('q');
      expect((await tick().pass()).ring.due).toBe(1);
      expect(await rungAt(id!)).not.toBeNull();
    });
  });

  describe('a ring that half fails', () => {
    test('leaves only the failed bells unrung, and the next pass rings only those', async () => {
      const ids = await enqueueN(t.store, 4);
      t.clock.advance(2_000);
      transport.failWhere((item) => item.bell.jobId === ids[1]);
      const run = await tick().run();
      expect(run.ring).toMatchObject({ due: 4, rung: 3, unreachable: 1 });
      expect(run.ok).toBe(false);
      expect(await Promise.all(ids.map(rungAt))).toEqual([
        expect.anything(),
        null,
        expect.anything(),
        expect.anything(),
      ]);

      transport.attempts.length = 0;
      const next = await tick().run();
      expect(next).toMatchObject({ ok: true, ring: { due: 1, rung: 1 } });
      expect(transport.attempts.map((attempt) => attempt.jobId)).toEqual([ids[1]]);
    });

    test('a failure is recorded for the last-tick status, a success clears the signal', async () => {
      await enqueueN(t.store, 1);
      t.clock.advance(2_000);
      transport.throwNext();
      const failed = await tick().run();
      expect(failed).toMatchObject({ ok: false, ring: { unreachable: 1 } });
      const status = await t.store.maintenance.tickStatus();
      expect(status.lastFailureAt).toBe(t.clock.now());
      expect(status.lastSuccessAt).toBeNull();

      t.clock.advance(1_000);
      expect((await tick().run()).ok).toBe(true);
      expect((await t.store.maintenance.tickStatus()).lastSuccessAt).toBe(t.clock.now());
    });
  });

  describe('recovery', () => {
    test('an expired lease is recovered and counted, and its job is rung again', async () => {
      const dead = await claimOne(t, { attempts: 3, backoff: 0 });
      expireLease(t, dead, 1);
      const run = await tick().run();
      expect(run).toMatchObject({ recovered: 1, ring: { due: 1, rung: 1 } });
      expect((await readJob(t, dead.id))?.state).toBe('waiting');
      expect(transport.buffered('q').ready).toBe(1);
    });
  });

  describe('delayed jobs and the window', () => {
    test('a delayed job inside the window is rung with a relative delay, and is never early', async () => {
      const [id] = await enqueueN(t.store, 1, { delay: 3_000 });
      t.clock.advance(2_500);
      const pass = await tick().pass();
      expect(pass.ring).toMatchObject({ due: 1, rung: 1 });
      expect(transport.attempts).toEqual([{ queue: 'q', jobId: id, deliverAfterMs: 500 }]);
      expect(transport.buffered('q')).toMatchObject({ ready: 0, delayed: 1 });
      t.clock.advance(499);
      expect(transport.buffered('q').ready).toBe(0);
      t.clock.advance(1);
      expect(transport.buffered('q').ready).toBe(1);
    });

    test('a job outside the window waits for a later tick', async () => {
      await enqueueN(t.store, 1, { delay: 60_000 });
      expect((await tick().pass()).ring.due).toBe(0);
      t.clock.advance(54_000);
      expect((await tick().pass()).ring).toMatchObject({ due: 1 });
    });

    test('a transport that cannot delay rings a delayed job only once it is due, as a plain bell', async () => {
      const store = t.another({ ringWindowMs: 0 });
      const none = new RecordingTransport({
        clock: t.clock,
        capabilities: { maxDeliverDelayMs: 0 },
      });
      const zero = ticker(store, none, { intervalMs: INTERVAL });
      expect(zero.config.windowMs).toBe(0);
      const [id] = await enqueueN(t.store, 1, { delay: 3_000 });
      t.clock.advance(2_999);
      expect((await zero.pass()).ring.due).toBe(0);
      t.clock.advance(1);
      expect((await zero.pass()).ring).toMatchObject({ due: 1, rung: 1 });
      expect(none.attempts).toEqual([{ queue: 'q', jobId: id, deliverAfterMs: 0 }]);
    });
  });

  describe('bounds', () => {
    test('a backlog is rung up to the per-queue cap in a pass, and no further', async () => {
      await enqueueN(t.store, 30, {}, 'big');
      await enqueueN(t.store, 3, {}, 'small');
      t.clock.advance(2_000);
      const seen = new Set<string>();
      for (const expected of [13, 10, 10]) {
        const before = transport.attempts.length;
        const pass = await tick({ maxRingsPerQueue: 10 }).pass();
        expect(pass.ring.due).toBe(expected);
        for (const attempt of transport.attempts.slice(before)) seen.add(attempt.jobId!);
      }
      expect(seen.size).toBe(33);
      expect((await tick({ maxRingsPerQueue: 10 }).pass()).ring.due).toBe(0);
    });

    test('a long backlog drains within the budget loop of one invocation', async () => {
      await enqueueN(t.store, 60, { delay: 1_000 });
      t.clock.advance(1_000);
      const run = await tick({ maxItems: 10 }).run();
      expect(run.passes).toBeGreaterThanOrEqual(6);
      expect(run).toMatchObject({ promoted: 60, moreWork: false, ok: true });
      expect((await t.store.counts('q')).waiting).toBe(60);
    });

    test('a spent run budget still runs one pass, and reports the work left', async () => {
      await enqueueN(t.store, 30, { delay: 1_000 });
      t.clock.advance(1_000);
      const run = await tick({ maxItems: 10, maxRunMs: 0 }).run();
      expect(run).toMatchObject({ passes: 1, promoted: 10, moreWork: true, ok: true });
    });
  });

  describe('telemetry and the report', () => {
    test('step durations, counts and the pass are reported, and a throwing sink changes nothing', async () => {
      const [id] = await enqueueN(t.store, 1);
      t.clock.advance(2_000);
      const telemetry = recordedTelemetry();
      await tick({}, t.store, telemetry).run();
      expect(telemetry.durations.map(([step]) => step)).toEqual(
        expect.arrayContaining(['recover', 'ringQuery', 'ring', 'mark', 'pass'])
      );
      expect(Object.fromEntries(telemetry.gauges)).toMatchObject({
        'rings.due': 1,
        'rings.rung': 1,
        more_work: 0,
        ok: 1,
        'jobs.completed_total': 0,
        'jobs.failed_total': 0,
      });
      expect(await rungAt(id!)).not.toBeNull();

      const broken = {
        duration() {
          throw new Error('sink');
        },
        gauge() {
          throw new Error('sink');
        },
        error() {
          throw new Error('sink');
        },
      };
      t.clock.advance(INTERVAL);
      expect(
        await ticker(t.store, transport, { intervalMs: INTERVAL }, broken).run()
      ).toMatchObject({
        ok: true,
        ring: { rung: 1 },
      });
    });

    test('the report is counts and milliseconds: no id, queue name or payload', async () => {
      const [id] = await enqueueN(t.store, 1, {}, 'secret-queue');
      t.clock.advance(2_000);
      const text = JSON.stringify(await tick().run());
      expect(text).not.toContain(id!);
      expect(text).not.toContain('secret-queue');
    });

    test('a store failure is recorded, reported to the telemetry and rethrown', async () => {
      const telemetry = recordedTelemetry();
      const closed = t.another();
      const failing = ticker(
        Object.assign(Object.create(closed), {
          tick: async () => {
            throw new Error('database down');
          },
        }),
        transport,
        { intervalMs: INTERVAL },
        telemetry
      );
      await expect(failing.run()).rejects.toThrow('database down');
      expect(telemetry.errors.map(([step]) => step)).toEqual(['tick']);
      expect((await t.store.maintenance.tickStatus()).lastFailureAt).not.toBeNull();
    });
  });
});
