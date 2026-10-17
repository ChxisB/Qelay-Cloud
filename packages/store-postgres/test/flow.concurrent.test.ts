import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { recording, resetTables } from './finishHelpers';
import { addTree, fanOut, summary } from './flowHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

describeDb('flows: concurrent completion', () => {
  const log = recording();
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ recorder: log.recorder, poolSize: 8 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    log.events.length = 0;
  });

  test('the last two children completing together release the parent exactly once (1,000 times)', async () => {
    const other = t.another();
    const repetitions = 1000;
    let rings = 0;
    for (let at = 0; at < repetitions; at++) {
      const [parent] = await addTree(t.store, fanOut(2));
      const [first, second] = await t.store.claim('children', 'w', 2);
      const outcomes = await Promise.all([
        t.store.complete(first!.lease, at),
        other.complete(second!.lease, at),
      ]);
      rings += outcomes.reduce((sum, outcome) => sum + outcome.rings.length, 0);
      const row = await summary(t, parent!.id);
      expect(row!.state).toBe('waiting');
      const [claimed] = await t.store.claim('parents', 'w', 1);
      expect(claimed!.id).toBe(parent!.id);
      await t.store.complete(claimed!.lease, at);
    }
    expect(rings).toBe(repetitions);
    expect(log.events.filter((event) => event.type === 'promoted')).toHaveLength(repetitions);
  }, 300_000);

  test('many children finishing at once release the parent once', async () => {
    const stores = [t.store, t.another(), t.another(), t.another()];
    for (let round = 0; round < 25; round++) {
      const [parent] = await addTree(t.store, fanOut(8));
      const claimed = await t.store.claim('children', 'w', 8);
      const outcomes = await Promise.all(
        claimed.map((job, at) => stores[at % stores.length]!.complete(job.lease, at))
      );
      expect(outcomes.reduce((sum, outcome) => sum + outcome.rings.length, 0)).toBe(1);
      expect((await summary(t, parent!.id))!.state).toBe('waiting');
      const [taken] = await t.store.claim('parents', 'w', 1);
      await t.store.complete(taken!.lease, null);
    }
    expect(log.events.filter((event) => event.type === 'promoted')).toHaveLength(25);
  }, 120_000);
});
