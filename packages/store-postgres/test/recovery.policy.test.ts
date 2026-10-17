import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import {
  blobOf,
  claimOne,
  configureQueue,
  expireLease,
  metric,
  readJob,
  recording,
  resetTables,
  retryStateOf,
} from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore, START } from './storeHelpers';

const LEASE = 30_000;
const TICK = 10_000;

describeDb('recovery: timeouts, stalls and limits', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ leaseMs: LEASE });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  /** Claims the job again (after its backoff, which is 0 here) and lets its lease lapse. */
  async function crash(queue = 'q') {
    const [job] = await t.store.claim(queue, 'w', 1);
    expireLease(t, job!);
    return (await t.store.recoverExpired()).recovered;
  }

  test('a lease that expired at the processing timeout is a timeout, not a stall', async () => {
    const job = await claimOne(t, { attempts: 3, backoff: 0, timeout: 5_000 });
    t.clock.advance(5_000);
    expect((await readJob(t, job.id))!.lease_until).toBe(String(START + 5_000));
    await t.store.recoverExpired();
    const row = await readJob(t, job.id);
    const state = retryStateOf(row);
    expect(state.stalls).toBe(0);
    expect(state.attempts[0]).toMatchObject({
      reason: 'timeout',
      error: 'Job processing timed out',
    });
    expect(row).toMatchObject({ state: 'waiting', attempts: 1 });
  });

  test('a timeout on the last attempt is a DLQ entry with the reason timeout', async () => {
    const job = await claimOne(t, { attempts: 1, timeout: 5_000 });
    t.clock.advance(5_000);
    await t.store.recoverExpired();
    const row = (await readJob(t, job.id))!;
    expect(row).toMatchObject({
      state: 'failed',
      failure_reason: 'timeout',
      error: 'Job processing timed out',
    });
    expect(blobOf(row).reason).toBe('timeout');
  });

  test('a lease that expires before the timeout is a stall', async () => {
    const job = await claimOne(t, { attempts: 3, backoff: 0, timeout: 10 * LEASE });
    expireLease(t, job);
    await t.store.recoverExpired();
    expect(retryStateOf(await readJob(t, job.id)).attempts[0]).toMatchObject({ reason: 'stalled' });
  });

  test('a stall limit sends the job to the DLQ with attempts left, as stalled', async () => {
    await t.store.queues.setStallConfig('q', { maxStalls: 2 });
    const job = await claimOne(t, { attempts: 10, backoff: 0 });
    expireLease(t, job);
    await t.store.recoverExpired();
    expect((await readJob(t, job.id))!.state).toBe('waiting');
    expect(await crash()).toBe(1);
    const row = (await readJob(t, job.id))!;
    expect(row).toMatchObject({ state: 'failed', attempts: 2, failure_reason: 'stalled' });
    expect(blobOf(row).attempts.map((record) => record.reason)).toEqual(['stalled', 'stalled']);
    expect((await metric(t, 'q', 'failed')).total).toBe(1);
  });

  test('the default stall limit is 3', async () => {
    const job = await claimOne(t, { attempts: 10, backoff: 0 });
    expireLease(t, job);
    await t.store.recoverExpired();
    expect(await crash()).toBe(1);
    expect((await readJob(t, job.id))!.state).toBe('waiting');
    expect(await crash()).toBe(1);
    expect((await readJob(t, job.id))!).toMatchObject({ state: 'failed', attempts: 3 });
  });

  test('a stall limit of 0 means no limit: only the attempts end the job', async () => {
    await t.store.queues.setStallConfig('q', { maxStalls: 0 });
    const job = await claimOne(t, { attempts: 6, backoff: 0 });
    expireLease(t, job);
    await t.store.recoverExpired();
    for (let n = 0; n < 4; n++) await crash();
    expect((await readJob(t, job.id))!).toMatchObject({ state: 'waiting', attempts: 5 });
    await crash();
    expect((await readJob(t, job.id))!).toMatchObject({ state: 'failed', attempts: 6 });
  });

  test('timeouts never count toward the stall limit', async () => {
    await t.store.queues.setStallConfig('q', { maxStalls: 1 });
    const job = await claimOne(t, { attempts: 5, backoff: 0, timeout: 1_000 });
    for (let n = 0; n < 4; n++) {
      t.clock.advance(1_000);
      await t.store.recoverExpired();
      await t.store.claim('q', 'w', 1);
    }
    expect((await readJob(t, job.id))!).toMatchObject({ state: 'active', attempts: 4 });
  });

  test('stalls and explicit failures count separately toward the limits', async () => {
    await t.store.queues.setStallConfig('q', { maxStalls: 2 });
    const job = await claimOne(t, { attempts: 10, backoff: 0 });
    await t.store.fail(job.lease, { message: 'a', unrecoverable: false });
    for (let n = 0; n < 3; n++) {
      const [again] = await t.store.claim('q', 'w', 1);
      await t.store.fail(again!.lease, { message: 'b', unrecoverable: false });
    }
    expect(retryStateOf(await readJob(t, job.id)).stalls).toBe(0);
    expect((await readJob(t, job.id))!.attempts).toBe(4);
  });

  test('the stall limit is per queue', async () => {
    await t.store.queues.setStallConfig('strict', { maxStalls: 1 });
    const strict = await claimOne(t, { attempts: 5, backoff: 0 }, 'strict');
    const lax = await claimOne(t, { attempts: 5, backoff: 0 }, 'lax');
    expireLease(t, strict);
    expect((await t.store.recoverExpired()).recovered).toBe(2);
    expect((await readJob(t, strict.id))!.state).toBe('failed');
    expect((await readJob(t, lax.id))!.state).toBe('waiting');
    expect((await metric(t, 'strict', 'failed')).total).toBe(1);
    expect((await metric(t, 'lax', 'failed')).total).toBe(0);
  });

  test('a bad stall configuration falls back to the default', async () => {
    await configureQueue(t, 'q', { stall: { maxStalls: 'many' } });
    const job = await claimOne(t, { attempts: 5, backoff: 0 });
    expireLease(t, job);
    await t.store.recoverExpired();
    await crash();
    await crash();
    expect((await readJob(t, job.id))!.state).toBe('failed');
  });
});

describeDb('recovery: concurrent passes and the crash bound', () => {
  const log = recording();
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ recorder: log.recorder, leaseMs: LEASE, poolSize: 10 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    log.events.length = 0;
  });

  test('passes at the same time take each job once: attempts, DLQ entries and metrics are exact', async () => {
    const jobs = [];
    for (let n = 0; n < 12; n++) jobs.push(await claimOne(t, { attempts: 1 }));
    t.clock.advance(2 * LEASE);
    log.events.length = 0;
    const reports = await Promise.all(Array.from({ length: 6 }, () => t.store.recoverExpired(5)));
    // A pass may find every candidate locked by another; drain what is left.
    let recovered = reports.reduce((sum, report) => sum + report.recovered, 0);
    for (let more = true; more;) {
      const next = await t.store.recoverExpired(5);
      recovered += next.recovered;
      more = next.recovered > 0;
    }
    expect(recovered).toBe(12);
    expect(await t.store.listDlq('q')).toHaveLength(12);
    expect(log.events.filter((event) => event.type === 'failed')).toHaveLength(12);
    expect((await metric(t, 'q', 'failed')).total).toBe(12);
    for (const job of jobs) expect((await readJob(t, job.id))!.attempts).toBe(1);
  });

  test('fail racing recovery on the last attempt writes one DLQ entry and one metric', async () => {
    for (let round = 0; round < 10; round++) {
      await resetTables(t);
      const job = await claimOne(t, { attempts: 1 });
      // The worker's fail lands before its lease ends: recovery cannot take the job once it is failed.
      t.clock.advance(LEASE - 1);
      const [failed] = await Promise.all([
        t.store.fail(job.lease, { message: 'x', unrecoverable: false }),
        t.store.recoverExpired(),
      ]);
      t.clock.advance(1);
      await t.store.recoverExpired();
      expect(failed.ok).toBe(true);
      expect(await t.store.listDlq('q')).toHaveLength(1);
      expect((await metric(t, 'q', 'failed')).total).toBe(1);
      expect((await readJob(t, job.id))!.attempts).toBe(1);
    }
  });

  /**
   * A simulation of the tick: every TICK ms it recovers expired leases, rings the claimable jobs
   * (the store has no ring window here, so the tick does it) and answers each bell with one claim.
   * A job whose worker crashed right after claiming must run again within the lease plus two ticks.
   */
  test.each([0, 1, 4_999, 9_999])(
    'a crashed job runs again within the lease plus two tick intervals (tick phase %i ms)',
    async (phase) => {
      const job = await claimOne(t, { attempts: 3, backoff: 5_000 });
      const crashedAt = t.clock.now();
      let reclaimedAt = -1;
      t.clock.advance(phase);
      for (let tick = 0; tick < 20 && reclaimedAt < 0; tick++) {
        await t.store.recoverExpired();
        const [again] = await t.store.claim('q', 'w2', 1);
        if (again) {
          expect(again.id).toBe(job.id);
          reclaimedAt = t.clock.now();
        }
        t.clock.advance(TICK);
      }
      expect(reclaimedAt).toBeGreaterThan(0);
      expect(reclaimedAt - crashedAt).toBeLessThanOrEqual(LEASE + 2 * TICK);
    }
  );
});
