import { describe, expect, test } from 'bun:test';
import type { Execution } from '../../../packages/core/src';
import type { WorkflowHarness } from './fixtures';
import { moveTo, seed } from './fixtures';

/** The caller's copy of a run with the timeout applied, as the engine builds it before `expireWait`. */
function timedOut(exec: Execution): Execution {
  return {
    ...exec,
    state: 'failed',
    failureReason: 'waitFor timed out',
    steps: { gate: { status: 'failed', error: 'timeout' } },
  };
}

export function waitsContract(h: WorkflowHarness): void {
  describe('failing a timed-out wait', () => {
    test('writes the failure once, as one more version, while the signal is absent', async () => {
      await seed(h, 'e1', { currentNodeIndex: 1 });
      await h.store.parkForSignal('e1', 'approved', h.clock.now() + 1000);
      const parked = (await h.store.get('e1'))!;
      h.clock.advance(2000);
      const failed = timedOut(parked);
      expect(await h.store.expireWait(failed, 'approved', 1)).toEqual({ kind: 'expired' });
      expect([failed.version, failed.updatedAt]).toEqual([parked.version! + 1, h.clock.now()]);
      const stored = (await h.store.get('e1'))!;
      expect(stored).toMatchObject({
        state: 'failed',
        failureReason: 'waitFor timed out',
        version: parked.version! + 1,
        currentNodeIndex: 1,
      });
      expect(stored.steps['gate']?.status).toBe('failed');
    });

    test('loses to a signal that was recorded first, and writes nothing', async () => {
      await seed(h, 'e1');
      await h.store.parkForSignal('e1', 'approved');
      await h.store.recordSignal('e1', 'approved', { ok: 1 });
      const claimed = (await h.store.get('e1'))!;
      const outcome = await h.store.expireWait(timedOut(claimed), 'approved', 0);
      expect(outcome).toEqual({ kind: 'signalled', signals: { approved: { ok: 1 } } });
      expect(await h.store.get('e1')).toEqual(claimed);
    });

    test('a signal that came before the run parked also wins', async () => {
      await seed(h, 'e1');
      await h.store.recordSignal('e1', 'early', 1);
      const outcome = await h.store.expireWait((await h.store.get('e1'))!, 'early', 0);
      expect(outcome.kind).toBe('signalled');
      expect((await h.store.get('e1'))!.state).toBe('running');
    });

    test('is moved when the run is elsewhere: another cursor, not live, or gone', async () => {
      await seed(h, 'e1', { currentNodeIndex: 2 });
      await seed(h, 'e2');
      await moveTo(h, 'e2', { state: 'completed' });
      const e1 = (await h.store.get('e1'))!;
      const e2 = (await h.store.get('e2'))!;
      expect(await h.store.expireWait(timedOut(e1), 'go', 1)).toEqual({ kind: 'moved' });
      expect(await h.store.expireWait(timedOut(e2), 'go', 0)).toEqual({ kind: 'moved' });
      expect(await h.store.expireWait(timedOut({ ...e1, id: 'nope' }), 'go', 2)).toEqual({
        kind: 'moved',
      });
      expect((await h.store.get('e1'))!.state).toBe('running');
      expect((await h.store.get('e2'))!.state).toBe('completed');
    });

    test('once it has won, a late signal is refused: the run is failed', async () => {
      await seed(h, 'e1');
      await h.store.parkForSignal('e1', 'approved');
      await h.store.expireWait(timedOut((await h.store.get('e1'))!), 'approved', 0);
      await expect(h.store.recordSignal('e1', 'approved', 1)).rejects.toThrow('cannot receive');
    });
  });

  describe('handing out expired waits', () => {
    const park = async (id: string, deadlineAt?: number, event = 'go') => {
      await seed(h, id);
      await h.store.parkForSignal(id, event, deadlineAt);
    };

    test('returns the parked runs whose deadline has passed, earliest first', async () => {
      const now = h.clock.now();
      await park('b', now + 100);
      await park('a', now + 100);
      await park('c', now + 50, 'other');
      await park('late', now + 10_000);
      await park('never');
      h.clock.advance(200);
      const due = await h.store.claimDueWaits();
      expect(due).toEqual([
        { id: 'c', workflowName: 'order', event: 'other', nodeIndex: 0, deadlineAt: now + 50 },
        { id: 'a', workflowName: 'order', event: 'go', nodeIndex: 0, deadlineAt: now + 100 },
        { id: 'b', workflowName: 'order', event: 'go', nodeIndex: 0, deadlineAt: now + 100 },
      ]);
    });

    test('a deadline that is exactly now is due', async () => {
      await park('a', h.clock.now());
      expect((await h.store.claimDueWaits()).map((d) => d.id)).toEqual(['a']);
    });

    test('hands a wait to one caller for the length of the lease, then to the next', async () => {
      await park('a', h.clock.now() + 10);
      h.clock.advance(20);
      expect((await h.store.claimDueWaits({ leaseMs: 1000 })).length).toBe(1);
      expect(await h.store.claimDueWaits({ leaseMs: 1000 })).toEqual([]);
      h.clock.advance(999);
      expect(await h.store.claimDueWaits({ leaseMs: 1000 })).toEqual([]);
      h.clock.advance(1);
      expect((await h.store.claimDueWaits({ leaseMs: 1000 })).length).toBe(1);
    });

    test('stops at the limit and leaves the rest for the next claim', async () => {
      for (const id of ['a', 'b', 'c']) await park(id, h.clock.now() + 1);
      h.clock.advance(5);
      const first = await h.store.claimDueWaits({ limit: 2 });
      const second = await h.store.claimDueWaits({ limit: 2 });
      expect(first.map((d) => d.id)).toEqual(['a', 'b']);
      expect(second.map((d) => d.id)).toEqual(['c']);
    });

    test('does not hand out a run that was signalled, moved on, failed, or parked again', async () => {
      const now = h.clock.now();
      for (const id of ['signalled', 'moved', 'failed', 'reparked']) await park(id, now + 1);
      await h.store.recordSignal('signalled', 'go', 1);
      await moveTo(h, 'moved', { state: 'running' });
      await h.store.expireWait(timedOut((await h.store.get('failed'))!), 'go', 0);
      h.clock.advance(10);
      await h.store.claimDueWaits({ limit: 1 });
      await h.store.parkForSignal('reparked', 'go', h.clock.now() + 5000);
      expect(await h.store.claimDueWaits()).toEqual([]);
      h.clock.advance(5000);
      expect((await h.store.claimDueWaits()).map((d) => d.id)).toEqual(['reparked']);
    });

    test('refuses a limit or a lease outside its bounds', async () => {
      for (const options of [{ limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { leaseMs: 0 }]) {
        await expect(h.store.claimDueWaits(options)).rejects.toThrow(RangeError);
      }
    });
  });
}
