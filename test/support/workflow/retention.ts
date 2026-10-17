import { describe, expect, test } from 'bun:test';
import type { Execution } from '../../../packages/core/src';
import type { WorkflowHarness } from './fixtures';
import { ids, seed, T0 } from './fixtures';

export function retentionContract(h: WorkflowHarness): void {
  const of = (id: string, over: Partial<Execution>) =>
    seed(h, id, { createdAt: T0 - 10_000, updatedAt: T0 - 10_000, ...over });
  const left = async (): Promise<string[]> => ids(await h.store.list()).sort();

  describe('cleanup', () => {
    test('deletes finished runs by default, and leaves live ones however old', async () => {
      await of('done', { state: 'completed' });
      await of('failed', { state: 'failed' });
      await of('run', { state: 'running' });
      await of('wait', { state: 'waiting' });
      await of('comp', { state: 'compensating' });
      await of('stuck', { state: 'compensation-stuck' });
      expect(await h.store.cleanup(0)).toBe(2);
      expect(await left()).toEqual(['comp', 'run', 'stuck', 'wait']);
    });

    test('the cutoff is inclusive: a run exactly maxAge old goes, one millisecond younger stays', async () => {
      await of('edge', { state: 'completed', updatedAt: T0 - 1000 });
      await of('young', { state: 'completed', updatedAt: T0 - 999 });
      expect(await h.store.cleanup(1000)).toBe(1);
      expect(await left()).toEqual(['young']);
    });

    test('takes the states it is given', async () => {
      await of('done', { state: 'completed' });
      await of('stuck', { state: 'compensation-stuck' });
      expect(await h.store.cleanup(0, ['compensation-stuck'])).toBe(1);
      expect(await left()).toEqual(['done']);
      expect(await h.store.cleanup(0, [])).toBe(0);
    });

    test('works through a backlog in batches, oldest first, until it returns less than the batch', async () => {
      for (let i = 0; i < 5; i++)
        await of(`e${i}`, { state: 'completed', updatedAt: T0 - 5000 + i });
      expect(await h.store.cleanup(0, undefined, 2)).toBe(2);
      expect(await left()).toEqual(['e2', 'e3', 'e4']);
      expect(await h.store.cleanup(0, undefined, 2)).toBe(2);
      expect(await h.store.cleanup(0, undefined, 2)).toBe(1);
      expect(await left()).toEqual([]);
    });

    test('does not archive what it deletes', async () => {
      await of('done', { state: 'completed' });
      await h.store.cleanup(0);
      expect(await h.store.getArchivedCount()).toBe(0);
    });

    test('refuses an age, a state or a batch it cannot work with, and deletes nothing', async () => {
      await of('done', { state: 'completed' });
      for (const age of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(h.store.cleanup(age)).rejects.toThrow(RangeError);
      }
      await expect(h.store.cleanup(0, ['bogus' as never])).rejects.toThrow(RangeError);
      for (const limit of [0, 10_001, 1.5]) {
        await expect(h.store.cleanup(0, undefined, limit)).rejects.toThrow(RangeError);
      }
      expect(await left()).toEqual(['done']);
    });
  });

  describe('archive', () => {
    test('moves finished runs to the archive and counts them', async () => {
      await of('done', { state: 'completed' });
      await of('failed', { state: 'failed' });
      await of('run', { state: 'running' });
      expect(await h.store.archive(0)).toBe(2);
      expect(await left()).toEqual(['run']);
      expect(await h.store.getArchivedCount()).toBe(2);
    });

    test('has the same inclusive cutoff, states and batches as cleanup', async () => {
      await of('edge', { state: 'completed', updatedAt: T0 - 1000 });
      await of('young', { state: 'completed', updatedAt: T0 - 999 });
      await of('stuck', { state: 'compensation-stuck', updatedAt: T0 - 1000 });
      expect(await h.store.archive(1000)).toBe(1);
      expect(await h.store.archive(1000, ['compensation-stuck'], 1)).toBe(1);
      expect(await left()).toEqual(['young']);
      expect(await h.store.getArchivedCount()).toBe(2);
    });

    test('an id archived twice has one archived copy: the later one replaces the earlier', async () => {
      await of('e1', { state: 'completed' });
      await h.store.archive(0);
      await of('e1', { state: 'failed', input: 'again' });
      await h.store.archive(0);
      expect(await h.store.getArchivedCount()).toBe(1);
    });
  });
}
