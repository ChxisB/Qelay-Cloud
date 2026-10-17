import { describe, expect, test } from 'bun:test';
import { hasSignal, SignalRejectedError } from '../../../packages/core/src';
import type { WorkflowHarness } from './fixtures';
import { moveTo, seed, T0 } from './fixtures';

export function signalsContract(h: WorkflowHarness): void {
  describe('recording a signal', () => {
    test('into a run that is not parked records it and changes nothing else', async () => {
      const before = await seed(h, 'e1');
      h.clock.advance(100);
      const outcome = await h.store.recordSignal('e1', 'approved', { by: 'sam' });
      expect(outcome).toEqual({
        found: true,
        resumed: false,
        workflowName: 'order',
        currentNodeIndex: 0,
      });
      const after = (await h.store.get('e1'))!;
      expect(after.signals).toEqual({ approved: { by: 'sam' } });
      expect([after.state, after.version]).toEqual(['running', before.version]);
      expect(after.updatedAt).toBe(h.clock.now());
    });

    test('into a parked run claims its resume once, and says where the gate was', async () => {
      await seed(h, 'e1', { currentNodeIndex: 3 });
      await h.store.parkForSignal('e1', 'approved');
      const parked = (await h.store.get('e1'))!;
      const first = await h.store.recordSignal('e1', 'approved', 1);
      expect(first).toEqual({
        found: true,
        resumed: true,
        workflowName: 'order',
        currentNodeIndex: 3,
      });
      const second = await h.store.recordSignal('e1', 'other', 2);
      expect(second.resumed).toBe(false);
      const after = (await h.store.get('e1'))!;
      expect([after.state, after.version]).toEqual(['running', parked.version! + 1]);
      expect(after.signals).toEqual({ approved: 1, other: 2 });
    });

    test('an execution that does not exist is reported, not thrown', async () => {
      expect(await h.store.recordSignal('nope', 'go', 1)).toEqual({
        found: false,
        resumed: false,
        workflowName: '',
        currentNodeIndex: 0,
      });
    });

    test('the same event twice is refused and the first payload stays', async () => {
      await seed(h, 'e1');
      await h.store.recordSignal('e1', 'approved', 'first');
      const error = await h.store.recordSignal('e1', 'approved', 'second').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SignalRejectedError);
      expect((error as Error).message).toBe(
        'Signal "approved" was already received for execution "e1"'
      );
      expect((await h.store.get('e1'))!.signals).toEqual({ approved: 'first' });
    });

    test.each(['completed', 'failed', 'compensating', 'compensation-stuck'] as const)(
      'a run that is %s cannot receive one',
      async (state) => {
        await seed(h, 'e1');
        await moveTo(h, 'e1', { state });
        const error = await h.store.recordSignal('e1', 'go', 1).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SignalRejectedError);
        expect((error as Error).message).toBe(
          `Execution "e1" is "${state}" and cannot receive the signal "go"`
        );
        expect((await h.store.get('e1'))!.signals).toEqual({});
      }
    );

    test('a signal with no payload is still there: the key is the evidence', async () => {
      await seed(h, 'e1');
      await h.store.recordSignal('e1', 'ping', undefined);
      const stored = (await h.store.get('e1'))!;
      expect(Object.hasOwn(stored.signals, 'ping')).toBe(true);
      await expect(h.store.recordSignal('e1', 'ping', 1)).rejects.toBeInstanceOf(
        SignalRejectedError
      );
      expect((await h.store.parkForSignal('e1', 'ping')).signalPresent).toBe(true);
    });
  });

  describe('events named like things every object has', () => {
    test.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty'])(
      'a gate named %s does not open before anything was signalled',
      async (event) => {
        await seed(h, 'e1');
        const parked = await h.store.parkForSignal('e1', event);
        expect(parked).toMatchObject({ signalPresent: false, parked: true });
        const outcome = await h.store.recordSignal('e1', event, 1);
        expect(outcome.resumed).toBe(true);
        expect((await h.store.parkForSignal('e1', event)).signalPresent).toBe(true);
      }
    );

    test('the event __proto__ is recorded as a key, resumes the run once and is found afterwards', async () => {
      await seed(h, 'e1');
      await h.store.parkForSignal('e1', '__proto__');
      const outcome = await h.store.recordSignal('e1', '__proto__', 'x');
      expect(outcome.resumed).toBe(true);
      const stored = (await h.store.get('e1'))!;
      expect(Object.hasOwn(stored.signals, '__proto__')).toBe(true);
      expect(hasSignal(stored.signals, '__proto__')).toBe(true);
      expect((await h.store.parkForSignal('e1', '__proto__')).signalPresent).toBe(true);
      await expect(h.store.recordSignal('e1', '__proto__', 'y')).rejects.toBeInstanceOf(
        SignalRejectedError
      );
    });
  });

  describe('parking at a waitFor', () => {
    test('moves a running run to waiting and counts as one more version', async () => {
      const before = await seed(h, 'e1');
      h.clock.advance(50);
      const outcome = await h.store.parkForSignal('e1', 'approved');
      expect(outcome).toEqual({ signalPresent: false, parked: true, signals: {} });
      const after = (await h.store.get('e1'))!;
      expect([after.state, after.version, after.updatedAt]).toEqual([
        'waiting',
        before.version! + 1,
        h.clock.now(),
      ]);
    });

    test('is idempotent from waiting: it parks again and the version stays', async () => {
      await seed(h, 'e1');
      await h.store.parkForSignal('e1', 'approved');
      const parked = (await h.store.get('e1'))!;
      expect((await h.store.parkForSignal('e1', 'approved')).parked).toBe(true);
      expect((await h.store.get('e1'))!.version).toBe(parked.version!);
    });

    test('does not park when the signal is already there, and hands back what is recorded', async () => {
      await seed(h, 'e1');
      await h.store.recordSignal('e1', 'approved', { ok: true });
      const outcome = await h.store.parkForSignal('e1', 'approved');
      expect(outcome).toEqual({
        signalPresent: true,
        parked: false,
        signals: { approved: { ok: true } },
      });
      expect((await h.store.get('e1'))!.state).toBe('running');
    });

    test('does not park a run that is not live, or one that is not there', async () => {
      await seed(h, 'e1');
      await moveTo(h, 'e1', { state: 'completed' });
      expect(await h.store.parkForSignal('e1', 'go')).toEqual({
        signalPresent: false,
        parked: false,
        signals: {},
      });
      expect((await h.store.get('e1'))!.state).toBe('completed');
      expect((await h.store.parkForSignal('nope', 'go')).parked).toBe(false);
    });

    test('refuses a deadline that is not a whole number of milliseconds, before changing anything', async () => {
      await seed(h, 'e1');
      for (const bad of [Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
        await expect(h.store.parkForSignal('e1', 'go', bad)).rejects.toThrow(RangeError);
      }
      expect((await h.store.get('e1'))!.state).toBe('running');
    });
  });

  describe('putting a claimed wait back', () => {
    test('a claimed run goes back to waiting, with its signal still recorded', async () => {
      await seed(h, 'e1', { currentNodeIndex: 2 });
      await h.store.parkForSignal('e1', 'go');
      await h.store.recordSignal('e1', 'go', 1);
      const claimed = (await h.store.get('e1'))!;
      expect(await h.store.restoreSignalWait('e1', 'go', 2)).toBe(true);
      const after = (await h.store.get('e1'))!;
      expect([after.state, after.version, after.signals]).toEqual([
        'waiting',
        claimed.version! + 1,
        { go: 1 },
      ]);
    });

    test('the restored run shows the event it awaited, with no deadline, so an operator can tell it was signalled', async () => {
      await seed(h, 'e1', { currentNodeIndex: 2 });
      await h.store.parkForSignal('e1', 'go', T0 + 60_000);
      await h.store.recordSignal('e1', 'go', 1);
      expect((await h.store.summaries({ id: 'e1' }))[0]!.waitEvent).toBeUndefined();
      expect(await h.store.restoreSignalWait('e1', 'go', 2)).toBe(true);
      const [summary] = await h.store.summaries({ id: 'e1' });
      expect(summary).toMatchObject({ state: 'waiting', waitEvent: 'go' });
      expect(summary!.waitDeadlineAt).toBeUndefined();
      // Its deadline is gone with the claim, so the tick's timed wait does not take it.
      h.clock.advance(120_000);
      expect(await h.store.claimDueWaits({ limit: 10, leaseMs: 1000 })).toEqual([]);
    });

    test('does nothing at another cursor, from another state, without the signal, or for a stranger', async () => {
      await seed(h, 'e1', { currentNodeIndex: 2 });
      await h.store.recordSignal('e1', 'go', 1);
      expect(await h.store.restoreSignalWait('e1', 'go', 1)).toBe(false);
      expect(await h.store.restoreSignalWait('e1', 'other', 2)).toBe(false);
      expect(await h.store.restoreSignalWait('nope', 'go', 2)).toBe(false);
      await seed(h, 'e3', { currentNodeIndex: 2 });
      await h.store.recordSignal('e3', 'go', 1);
      await moveTo(h, 'e3', { state: 'waiting' });
      expect(await h.store.restoreSignalWait('e3', 'go', 2)).toBe(false);
      expect((await h.store.get('e1'))!.state).toBe('running');
    });
  });
}
