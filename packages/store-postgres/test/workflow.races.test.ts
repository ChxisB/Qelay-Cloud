import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Execution } from '@qelay-cloud/core';
import { ExecutionStaleError, SignalRejectedError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { execution, T0 } from '../../../test/support/workflow';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

const settle = <T>(work: Promise<T>) =>
  work.then(
    (value) => ({ value }) as const,
    (error: unknown) => ({ error }) as const
  );

const stepWith = (name: string): Execution['steps'] => ({
  [name]: { status: 'completed', result: name } as never,
});

/** The caller's copy of a run with the timeout applied, as the engine builds it before `expireWait`. */
const timedOut = (exec: Execution): Execution => ({
  ...exec,
  state: 'failed',
  failureReason: 'waitFor timed out',
  steps: { gate: { status: 'failed', error: 'timeout' } as never },
});

describeDb('PostgresStore.workflows: callers racing on one run', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ poolSize: 12 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.fresh.sql`TRUNCATE qcloud_workflow_executions, qcloud_workflow_executions_archive`;
    t.clock.advance(T0 - t.clock.now());
  });

  const save = async (id: string, overrides: Partial<Execution> = {}) => {
    await t.store.workflows.save(execution(t.clock, id, overrides));
  };

  test('two engines that read the same run: one update lands, the other is refused as stale', async () => {
    const rounds = 1000;
    for (let round = 0; round < rounds; round += 1) {
      const id = `e${round}`;
      await save(id);
      const a = (await t.store.workflows.get(id))!;
      const b = (await t.store.workflows.get(id))!;
      a.steps = stepWith('a');
      b.steps = stepWith('b');
      const results = await Promise.all([
        settle(t.store.workflows.update(a)),
        settle(t.another().workflows.update(b)),
      ]);
      const lost = results.filter((r) => 'error' in r);
      expect(results.length - lost.length).toBe(1);
      const refusal = (lost[0] as { error: unknown }).error;
      expect(refusal).toBeInstanceOf(ExecutionStaleError);
      expect(refusal).toHaveProperty('actual', 1);
      const stored = (await t.store.workflows.get(id))!;
      expect(stored.version).toBe(1);
      expect(Object.keys(stored.steps)).toEqual(['value' in results[0]! ? 'a' : 'b']);
    }
  }, 120_000);

  test('a signal recorded while the engine runs the node survives the engine writing its step', async () => {
    for (let round = 0; round < 100; round += 1) {
      const id = `e${round}`;
      await save(id);
      const mine = (await t.store.workflows.get(id))!;
      mine.steps = stepWith('x');
      const [, written] = await Promise.all([
        t.store.workflows.recordSignal(id, 'go', round),
        settle(t.store.workflows.update(mine)),
      ]);
      // The signal never changes `version`, so the update is not refused whichever lands first.
      expect('error' in written).toBe(false);
      const stored = (await t.store.workflows.get(id))!;
      expect(stored.signals).toEqual({ go: round });
      expect(Object.keys(stored.steps)).toEqual(['x']);
    }
  }, 60_000);

  test('the same signal from several callers: exactly one resumes the run, the rest are duplicates', async () => {
    for (let round = 0; round < 200; round += 1) {
      const id = `e${round}`;
      await save(id);
      await t.store.workflows.parkForSignal(id, 'approved');
      const parked = (await t.store.workflows.get(id))!;
      const results = await Promise.all(
        [0, 1, 2, 3].map((n) => settle(t.another().workflows.recordSignal(id, 'approved', n)))
      );
      const won = results.filter((r) => 'value' in r);
      expect(won.length).toBe(1);
      expect(won[0]).toHaveProperty('value.resumed', true);
      for (const lost of results.filter((r) => 'error' in r)) {
        expect(lost).toHaveProperty('error', expect.any(SignalRejectedError));
        expect(lost).toHaveProperty('error.reason', 'duplicate');
      }
      const stored = (await t.store.workflows.get(id))!;
      expect([stored.state, stored.version]).toEqual(['running', parked.version! + 1]);
      expect(Object.keys(stored.signals)).toEqual(['approved']);
    }
  }, 60_000);

  test('a signal against a timeout: the run is resumed or failed, never both and never neither', async () => {
    for (let round = 0; round < 200; round += 1) {
      const id = `e${round}`;
      await save(id);
      await t.store.workflows.parkForSignal(id, 'go', t.clock.now() + 10);
      t.clock.advance(20);
      const claimed = (await t.store.workflows.claimDueWaits({ limit: 1 }))[0]!;
      const copy = (await t.store.workflows.get(id))!;
      const [signal, expiry] = await Promise.all([
        settle(t.store.workflows.recordSignal(id, 'go', 1)),
        settle(t.another().workflows.expireWait(timedOut(copy), 'go', claimed.nodeIndex)),
      ]);
      const stored = (await t.store.workflows.get(id))!;
      if (stored.state === 'running') {
        expect(signal).toHaveProperty('value.resumed', true);
        expect(expiry).toHaveProperty('value.kind', 'signalled');
        expect(stored.signals).toEqual({ go: 1 });
      } else {
        expect(stored.state).toBe('failed');
        expect(expiry).toHaveProperty('value.kind', 'expired');
        expect(signal).toHaveProperty('error.reason', 'state');
        expect(stored.signals).toEqual({});
      }
    }
  }, 60_000);

  test('callers claiming due waits at once get disjoint sets, and together no more than exist', async () => {
    for (let n = 0; n < 60; n += 1) {
      await save(`e${String(n).padStart(2, '0')}`);
      await t.store.workflows.parkForSignal(
        `e${String(n).padStart(2, '0')}`,
        'go',
        t.clock.now() + 1
      );
    }
    t.clock.advance(5);
    const claims = await Promise.all(
      [0, 1, 2, 3].map(() => t.another().workflows.claimDueWaits({ limit: 20, leaseMs: 60_000 }))
    );
    const all = claims.flatMap((claim) => claim.map((due) => due.id));
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeLessThanOrEqual(60);
    const rest = await t.store.workflows.claimDueWaits({ limit: 100, leaseMs: 60_000 });
    expect(new Set([...all, ...rest.map((due) => due.id)]).size).toBe(60);
    expect(all.length + rest.length).toBe(60);
  });

  describe('retention', () => {
    const seedDone = async (count: number, prefix: string) => {
      for (let n = 0; n < count; n += 1) await save(`${prefix}${n}`, { state: 'completed' });
      t.clock.advance(1000);
    };
    const counts = async () => {
      const [live] = await t.fresh.sql`SELECT count(*)::int AS n FROM qcloud_workflow_executions`;
      const [kept] = await t.fresh
        .sql`SELECT count(*)::int AS n FROM qcloud_workflow_executions_archive`;
      return { live: live.n as number, archived: kept.n as number };
    };

    test('callers archiving at once take each run once: nothing lost, nothing counted twice', async () => {
      await seedDone(300, 'a');
      const taken = await Promise.all(
        [0, 1, 2, 3].map(() => t.another().workflows.archive(0, ['completed'], 100))
      );
      const total = taken.reduce((sum, n) => sum + n, 0);
      expect(await counts()).toEqual({ live: 300 - total, archived: total });
      const last = await t.store.workflows.archive(0, ['completed'], 1000);
      expect(total + last).toBe(300);
      expect(await counts()).toEqual({ live: 0, archived: 300 });
      expect(await t.store.workflows.getArchivedCount()).toBe(300);
    });

    test('cleanup and archive at once never put one run in both tables or count it for both', async () => {
      await seedDone(200, 'c');
      const [gone, kept] = await Promise.all([
        t.store.workflows.cleanup(0, ['completed'], 150),
        t.another().workflows.archive(0, ['completed'], 150),
      ]);
      const now = await counts();
      expect(now.live).toBe(200 - gone - kept);
      expect(now.archived).toBe(kept);
      const [both] = await t.fresh.sql`
        SELECT count(*)::int AS n FROM qcloud_workflow_executions l
        JOIN qcloud_workflow_executions_archive a USING (namespace, id)`;
      expect(both.n).toBe(0);
    });

    test('a run that recovery moves on while retention picks it is kept, or is gone and recovery is refused', async () => {
      for (let round = 0; round < 100; round += 1) {
        const id = `r${round}`;
        await save(id, { state: 'failed' });
        t.clock.advance(1000);
        const mine = (await t.store.workflows.get(id))!;
        mine.state = 'running';
        const [removed, moved] = await Promise.all([
          t.store.workflows.cleanup(0, ['failed']),
          settle(t.another().workflows.update(mine)),
        ]);
        const stored = await t.store.workflows.get(id);
        if (removed === 1) {
          expect(stored).toBeNull();
          expect(moved).toHaveProperty('error', expect.any(ExecutionStaleError));
        } else {
          expect(stored?.state).toBe('running');
          expect('error' in moved).toBe(false);
        }
      }
    }, 60_000);
  });
});
