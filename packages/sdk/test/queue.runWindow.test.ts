import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { SdkFixture } from './support';
import { openFixture, resetFixture } from './support';

describeDb('queue: run window', () => {
  let f: SdkFixture;
  beforeAll(async () => {
    f = await openFixture();
  });
  afterAll(async () => {
    await f.drop();
  });
  beforeEach(async () => {
    await resetFixture(f);
  });

  // These run on the real clock, so the windows are built from the current UTC hour: one that opened this hour and
  // stays open for two, and one that opens twelve hours from now.
  const HOUR = 3_600_000;
  const hourNow = (): number => new Date().getUTCHours();
  const open = () => ({ cron: `0 ${hourNow()} * * *`, durationMs: 2 * HOUR });
  const closed = () => ({ cron: `0 ${(hourNow() + 12) % 24} * * *`, durationMs: HOUR });

  test('a window is stored per queue, read back with where it stands, and removed with null', async () => {
    const queue = f.queue();
    expect(await queue.getRunWindow()).toBeNull();
    const set = await queue.setRunWindow(closed());
    expect(set).toMatchObject({ ...closed(), timezone: 'UTC', open: false });
    expect(set!.closesAt - set!.opensAt).toBe(HOUR);
    expect(await queue.getRunWindow()).toEqual(set);
    expect(await f.queue('other').getRunWindow()).toBeNull();
    expect(await queue.setRunWindow(null)).toBeNull();
    expect(await queue.getRunWindow()).toBeNull();
  });

  test('a job added outside the window waits, and one inside runs', async () => {
    const queue = f.queue();
    await queue.setRunWindow(closed());
    await queue.add('n', { x: 1 });
    expect(await f.store.claim('q', 'w', 1)).toEqual([]);
    expect((await queue.setRunWindow(open()))!.open).toBe(true);
    expect(await f.store.claim('q', 'w', 1)).toHaveLength(1);
  });

  test('a window that is not valid is refused naming the field, and the stored one stays', async () => {
    const queue = f.queue();
    await queue.setRunWindow(open());
    for (const [window, option] of [
      [{ cron: 'nope', durationMs: HOUR }, 'runWindow'],
      [{ cron: '0 3 * * *', durationMs: 10 }, 'durationMs'],
      [{ cron: '0 3 * * *', durationMs: HOUR, timezone: 'Mars/Base' }, 'runWindow'],
    ] as const) {
      const refusal = await queue.setRunWindow(window).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(UnsupportedOptionError);
      expect((refusal as UnsupportedOptionError).option).toBe(option);
    }
    expect(await queue.getRunWindow()).toMatchObject(open());
  });
});
