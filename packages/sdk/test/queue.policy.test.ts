import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { SdkFixture } from './support';
import { openFixture, resetFixture } from './support';

describeDb('queue: retry policy', () => {
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

  test('a policy is stored per queue and applies to jobs added after it', async () => {
    const queue = f.queue();
    expect(await queue.getPolicy()).toBeNull();
    const policy = { attempts: 4, backoff: { type: 'exponential' as const, delay: 500 } };
    expect(await queue.setPolicy(policy)).toEqual(policy);
    expect(await f.queue('other').getPolicy()).toBeNull();
    const job = await queue.add('n', { x: 1 });
    expect((await queue.getJob(job.id!))!.opts.attempts).toBe(4);
    await expect(queue.setPolicy({ jitter: true } as never)).rejects.toBeInstanceOf(
      UnsupportedOptionError
    );
    expect(await queue.setPolicy(null)).toBeNull();
    expect(await queue.getPolicy()).toBeNull();
  });
});
