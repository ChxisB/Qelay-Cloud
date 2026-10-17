import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { TestStore } from './storeHelpers';
import { openTestStore, START } from './storeHelpers';

describeDb('tick state: the leader lease and the last tick', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.fresh.sql`DELETE FROM qcloud_tick_state`;
    t.clock.advance(START - t.clock.now());
  });

  const lease = (holder: string, ttlMs = 1_000, store = t.store) =>
    store.maintenance.acquireTickLease(holder, ttlMs);

  test('a free lease is taken, with the database time and its expiry', async () => {
    expect(await lease('a')).toEqual({
      held: true,
      leader: 'a',
      expiresAt: START + 1_000,
      at: START,
    });
  });

  test('another holder is refused while the lease runs, and is told who leads', async () => {
    await lease('a');
    t.clock.advance(999);
    expect(await lease('b')).toEqual({
      held: false,
      leader: 'a',
      expiresAt: START + 1_000,
      at: START + 999,
    });
  });

  test('the holder renews, and the lease moves forward from the renewal', async () => {
    await lease('a');
    t.clock.advance(600);
    expect((await lease('a')).expiresAt).toBe(START + 1_600);
    t.clock.advance(900);
    expect((await lease('b')).held).toBe(false);
  });

  test('an expired lease is taken over, at exactly its expiry and not a millisecond before', async () => {
    await lease('a');
    t.clock.advance(999);
    expect((await lease('b')).held).toBe(false);
    t.clock.advance(1);
    expect(await lease('b')).toMatchObject({ held: true, leader: 'b' });
    expect((await lease('a')).held).toBe(false);
  });

  test('a release hands the lease over at once, and only the holder can release', async () => {
    await lease('a');
    expect(await t.store.maintenance.releaseTickLease('b')).toBe(false);
    expect((await lease('b')).held).toBe(false);
    expect(await t.store.maintenance.releaseTickLease('a')).toBe(true);
    expect(await t.store.maintenance.releaseTickLease('a')).toBe(false);
    expect((await lease('b')).held).toBe(true);
  });

  test('two stores racing for a free lease: exactly one wins', async () => {
    const stores = Array.from({ length: 8 }, () => t.another());
    const results = await Promise.all(stores.map((store, n) => lease(`p${n}`, 1_000, store)));
    expect(results.filter((result) => result.held)).toHaveLength(1);
    const leader = results.find((result) => result.held)!.leader;
    expect(results.every((result) => result.held || result.leader === leader)).toBe(true);
  });

  test('a namespace has its own lease', async () => {
    await lease('a');
    const other = t.another({ namespace: 'other' });
    expect((await lease('b', 1_000, other)).held).toBe(true);
  });

  test('rejects an empty holder and a ttl that is not a positive integer', async () => {
    await expect(lease('')).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(lease('a', 0)).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(lease('a', 1.5)).rejects.toBeInstanceOf(UnsupportedOptionError);
  });

  describe('the status the control API reads', () => {
    test('is all nulls before any tick, with the database time', async () => {
      expect(await t.store.maintenance.tickStatus()).toEqual({
        lastSuccessAt: null,
        lastFailureAt: null,
        leader: null,
        leaderExpiresAt: null,
        now: START,
      });
    });

    test('a success and a failure are kept apart, each at the database time', async () => {
      await t.store.maintenance.recordTick(true);
      t.clock.advance(250);
      await t.store.maintenance.recordTick(false);
      t.clock.advance(250);
      expect(await t.store.maintenance.tickStatus()).toMatchObject({
        lastSuccessAt: START,
        lastFailureAt: START + 250,
        now: START + 500,
      });
      await t.store.maintenance.recordTick(true);
      expect((await t.store.maintenance.tickStatus()).lastSuccessAt).toBe(START + 500);
    });

    test('recording does not disturb the lease, and the lease does not disturb the record', async () => {
      await lease('a');
      await t.store.maintenance.recordTick(true);
      expect(await t.store.maintenance.tickStatus()).toMatchObject({
        leader: 'a',
        leaderExpiresAt: START + 1_000,
        lastSuccessAt: START,
      });
      await lease('a');
      expect((await t.store.maintenance.tickStatus()).lastSuccessAt).toBe(START);
    });

    test('a record that arrives out of order cannot move a timestamp back', async () => {
      t.clock.advance(1_000);
      await t.store.maintenance.recordTick(true);
      t.clock.advance(-1_000);
      await t.store.maintenance.recordTick(true);
      expect((await t.store.maintenance.tickStatus()).lastSuccessAt).toBe(START + 1_000);
    });

    test('a released lease reads as expired', async () => {
      await lease('a');
      await t.store.maintenance.releaseTickLease('a');
      expect(await t.store.maintenance.tickStatus()).toMatchObject({
        leader: 'a',
        leaderExpiresAt: 0,
      });
    });
  });
});
