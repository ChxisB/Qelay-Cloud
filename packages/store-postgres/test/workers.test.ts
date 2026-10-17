import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { DEFAULT_WORKER_ACTIVE_MS, DEFAULT_WORKER_EXPIRE_MS } from '../src/store/workers';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore, START } from './storeHelpers';

describeDb('workers: the registry', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    await t.fresh.sql`TRUNCATE qcloud_workers`;
  });

  test('register returns the worker, with defaults for what was not given', async () => {
    const info = await t.store.workers.register({ id: 'w1', queues: ['b', 'a', 'b'] });
    expect(info).toEqual({
      id: 'w1',
      name: 'w1',
      queues: ['a', 'b'],
      concurrency: 1,
      hostname: 'unknown',
      pid: 0,
      clientId: null,
      registeredAt: START,
      lastSeen: START,
      activeJobs: 0,
      processed: 0,
      failed: 0,
      active: true,
    });
    expect(await t.store.workers.list()).toEqual([info]);
  });

  test('re-registering replaces identity and queues but keeps the start time and counters', async () => {
    await t.store.workers.register({ id: 'w1', queues: ['a'], name: 'first', hostname: 'h1' });
    t.clock.advance(5_000);
    await t.store.workers.heartbeat('w1', { activeJobs: 2, processed: 10, failed: 1 });
    t.clock.advance(5_000);
    const again = await t.store.workers.register({
      id: 'w1',
      queues: ['b'],
      concurrency: 4,
      pid: 77,
      clientId: 'c1',
    });
    expect(again).toMatchObject({
      name: 'first',
      hostname: 'h1',
      queues: ['b'],
      concurrency: 4,
      pid: 77,
      clientId: 'c1',
      registeredAt: START,
      lastSeen: START + 10_000,
      activeJobs: 2,
      processed: 10,
      failed: 1,
    });
  });

  test('heartbeat refreshes lastSeen and the counters it is given, leaving the rest', async () => {
    await t.store.workers.register({ id: 'w1', queues: ['a'] });
    t.clock.advance(1_000);
    expect(await t.store.workers.heartbeat('w1', { activeJobs: 3 })).toBe(true);
    t.clock.advance(1_000);
    expect(await t.store.workers.heartbeat('w1', { processed: 9 })).toBe(true);
    expect((await t.store.workers.list())[0]).toMatchObject({
      lastSeen: START + 2_000,
      activeJobs: 3,
      processed: 9,
      failed: 0,
    });
  });

  test('heartbeat says false for a worker that is not registered, and creates nothing', async () => {
    expect(await t.store.workers.heartbeat('ghost')).toBe(false);
    expect(await t.store.workers.list()).toEqual([]);
  });

  test('active turns false after workerActiveMs without a heartbeat', async () => {
    await t.store.workers.register({ id: 'w1', queues: ['a'] });
    t.clock.advance(DEFAULT_WORKER_ACTIVE_MS - 1);
    expect((await t.store.workers.list())[0]!.active).toBe(true);
    t.clock.advance(1);
    expect((await t.store.workers.list())[0]!.active).toBe(false);
  });

  test('remove says whether there was a worker', async () => {
    await t.store.workers.register({ id: 'w1', queues: ['a'] });
    expect(await t.store.workers.remove('w1')).toBe(true);
    expect(await t.store.workers.remove('w1')).toBe(false);
    expect(await t.store.workers.list()).toEqual([]);
  });

  test('removeClient removes that client’s workers only', async () => {
    await t.store.workers.register({ id: 'a1', queues: ['q'], clientId: 'c1' });
    await t.store.workers.register({ id: 'a2', queues: ['q'], clientId: 'c1' });
    await t.store.workers.register({ id: 'b1', queues: ['q'], clientId: 'c2' });
    await t.store.workers.register({ id: 'n1', queues: ['q'] });
    expect(await t.store.workers.removeClient('c1')).toBe(2);
    expect(await t.store.workers.removeClient('c1')).toBe(0);
    expect((await t.store.workers.list()).map((worker) => worker.id)).toEqual(['b1', 'n1']);
  });

  test('list is ordered by id and holds only this namespace', async () => {
    const other = t.another({ namespace: 'other' });
    await t.store.workers.register({ id: 'z', queues: ['q'] });
    await t.store.workers.register({ id: 'm', queues: ['q'] });
    await other.workers.register({ id: 'a', queues: ['q'] });
    expect((await t.store.workers.list()).map((worker) => worker.id)).toEqual(['m', 'z']);
    expect((await other.workers.list()).map((worker) => worker.id)).toEqual(['a']);
    expect(await other.workers.remove('m')).toBe(false);
  });

  describe('expire', () => {
    test('deletes workers silent for workerExpireMs, and no others', async () => {
      await t.store.workers.register({ id: 'old', queues: ['q'] });
      t.clock.advance(DEFAULT_WORKER_EXPIRE_MS - 1);
      await t.store.workers.register({ id: 'fresh', queues: ['q'] });
      expect(await t.store.workers.expire()).toEqual({ expired: 0, more: false });
      t.clock.advance(1);
      expect(await t.store.workers.expire()).toEqual({ expired: 1, more: false });
      expect((await t.store.workers.list()).map((worker) => worker.id)).toEqual(['fresh']);
    });

    test('a heartbeat keeps a worker alive past the window', async () => {
      await t.store.workers.register({ id: 'w', queues: ['q'] });
      for (let n = 0; n < 4; n++) {
        t.clock.advance(DEFAULT_WORKER_EXPIRE_MS / 2);
        await t.store.workers.heartbeat('w');
        expect(await t.store.workers.expire()).toMatchObject({ expired: 0 });
      }
    });

    test('the limit is exact: it deletes that many, oldest first, and reports the rest', async () => {
      for (const id of ['a', 'b', 'c', 'd', 'e']) {
        await t.store.workers.register({ id, queues: ['q'] });
        t.clock.advance(1);
      }
      t.clock.advance(DEFAULT_WORKER_EXPIRE_MS);
      expect(await t.store.workers.expire(2)).toEqual({ expired: 2, more: true });
      expect((await t.store.workers.list()).map((worker) => worker.id)).toEqual(['c', 'd', 'e']);
      expect(await t.store.workers.expire(3)).toEqual({ expired: 3, more: false });
    });

    test('a worker expired while it was paused registers again and starts fresh', async () => {
      await t.store.workers.register({ id: 'w', queues: ['q'] });
      await t.store.workers.heartbeat('w', { processed: 5 });
      t.clock.advance(DEFAULT_WORKER_EXPIRE_MS);
      await t.store.workers.expire();
      expect(await t.store.workers.heartbeat('w')).toBe(false);
      expect(await t.store.workers.register({ id: 'w', queues: ['q'] })).toMatchObject({
        processed: 0,
        registeredAt: START + DEFAULT_WORKER_EXPIRE_MS,
      });
    });

    test('concurrent expiries delete each stale worker once', async () => {
      for (let n = 0; n < 20; n++) await t.store.workers.register({ id: `w${n}`, queues: ['q'] });
      t.clock.advance(DEFAULT_WORKER_EXPIRE_MS);
      const stores = [t.store, t.another(), t.another(), t.another()];
      const results = await Promise.all(stores.map((store) => store.workers.expire(100)));
      expect(results.reduce((sum, result) => sum + result.expired, 0)).toBe(20);
      expect(await t.store.workers.list()).toEqual([]);
    });
  });

  test('the expiry and activity windows are options of the store', async () => {
    const custom = t.another({ workerActiveMs: 1_000, workerExpireMs: 2_000 });
    await custom.workers.register({ id: 'w', queues: ['q'] });
    t.clock.advance(1_000);
    expect((await custom.workers.list())[0]!.active).toBe(false);
    expect(await custom.workers.expire()).toMatchObject({ expired: 0 });
    t.clock.advance(1_000);
    expect(await custom.workers.expire()).toMatchObject({ expired: 1 });
  });

  test.each<[string, Parameters<TestStore['store']['workers']['register']>[0], string]>([
    ['no queues', { id: 'w', queues: [] }, 'queues'],
    ['a blank queue name', { id: 'w', queues: [''] }, 'queues'],
    ['a blank id', { id: '', queues: ['q'] }, 'id'],
    ['a zero concurrency', { id: 'w', queues: ['q'], concurrency: 0 }, 'concurrency'],
    ['a fractional pid', { id: 'w', queues: ['q'], pid: 1.5 }, 'pid'],
    ['a blank client id', { id: 'w', queues: ['q'], clientId: '' }, 'clientId'],
  ])('register rejects %s, and stores nothing', async (_label, registration, mention) => {
    const error = await t.store.workers.register(registration).catch((caught) => caught);
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    expect(error.message).toContain(mention);
    expect(await t.store.workers.list()).toEqual([]);
  });

  test('heartbeat rejects counters that are not counts', async () => {
    await t.store.workers.register({ id: 'w', queues: ['q'] });
    await expect(t.store.workers.heartbeat('w', { processed: -2 })).rejects.toBeInstanceOf(
      UnsupportedOptionError
    );
    await expect(t.store.workers.heartbeat('w', { failed: 1.5 })).rejects.toBeInstanceOf(
      UnsupportedOptionError
    );
  });
});
