import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { claimOne, recording, resetTables } from '../../store-postgres/test/finishHelpers';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { enqueueN, openTestStore } from '../../store-postgres/test/storeHelpers';
import { RecordingTransport, recordedTelemetry, ticker } from './support';

const INTERVAL = 5_000;

describeDb('maintenance tick: the gauges', () => {
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

  test('the ok gauge is 0 on a pass whose ring failed and 1 on the next that did not', async () => {
    await enqueueN(t.store, 1);
    t.clock.advance(2_000);
    transport.throwNext();
    const failing = recordedTelemetry();
    await tick({}, t.store, failing).run();
    expect(failing.gauges.at(-1)).toEqual(['ok', 0]);
    t.clock.advance(1_000);
    const healthy = recordedTelemetry();
    await tick({}, t.store, healthy).run();
    expect(healthy.gauges.at(-1)).toEqual(['ok', 1]);
  });

  test('the lifetime totals follow terminal outcomes only, and a failed read costs the pass nothing', async () => {
    const done = await claimOne(t, { attempts: 1 });
    await t.store.complete(done.lease, 'ok');
    const dead = await claimOne(t, { attempts: 1 });
    await t.store.fail(dead.lease, { message: 'boom', unrecoverable: false });
    const retried = await claimOne(t, { attempts: 3, backoff: 0 });
    await t.store.fail(retried.lease, { message: 'boom', unrecoverable: false });
    const telemetry = recordedTelemetry();
    await tick({}, t.store, telemetry).run();
    expect(Object.fromEntries(telemetry.gauges)).toMatchObject({
      'jobs.completed_total': 1,
      'jobs.failed_total': 1,
    });

    const unreadable = recordedTelemetry();
    const store = Object.assign(Object.create(t.store), {
      metrics: {
        totals: async () => {
          throw new Error('read failed');
        },
      },
    });
    t.clock.advance(INTERVAL);
    const run = await tick({}, store, unreadable).run();
    expect(run.ok).toBe(true);
    expect(unreadable.errors.map(([step]) => step)).toEqual(['totals']);
    expect(unreadable.gauges.map(([name]) => name)).not.toContain('jobs.failed_total');
    expect(unreadable.gauges.at(-1)).toEqual(['ok', 1]);
  });
});
