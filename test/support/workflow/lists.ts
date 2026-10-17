import { describe, expect, test } from 'bun:test';
import type { Execution } from '../../../packages/core/src';
import type { WorkflowHarness } from './fixtures';
import { ids, seed, T0 } from './fixtures';

export function listsContract(h: WorkflowHarness): void {
  describe('list', () => {
    test('is newest first, with the id breaking a tie from the larger down', async () => {
      await seed(h, 'a', { createdAt: T0 + 1 });
      await seed(h, 'b', { createdAt: T0 + 3 });
      await seed(h, 'c', { createdAt: T0 + 3 });
      await seed(h, 'd', { createdAt: T0 + 2 });
      expect(ids(await h.store.list())).toEqual(['c', 'b', 'd', 'a']);
    });

    test('filters by workflow, by state, and by both', async () => {
      await seed(h, 'a', { workflowName: 'x', state: 'running', createdAt: T0 + 1 });
      await seed(h, 'b', { workflowName: 'x', state: 'completed', createdAt: T0 + 2 });
      await seed(h, 'c', { workflowName: 'y', state: 'running', createdAt: T0 + 3 });
      expect(ids(await h.store.list('x'))).toEqual(['b', 'a']);
      expect(ids(await h.store.list(undefined, 'running'))).toEqual(['c', 'a']);
      expect(ids(await h.store.list('x', 'running'))).toEqual(['a']);
      expect(await h.store.list('z')).toEqual([]);
    });

    test('pages with limit and offset in one stable order', async () => {
      for (let i = 0; i < 7; i++) await seed(h, `e${i}`, { createdAt: T0 + i });
      expect(ids(await h.store.list(undefined, undefined, { limit: 3 }))).toEqual([
        'e6',
        'e5',
        'e4',
      ]);
      expect(ids(await h.store.list(undefined, undefined, { limit: 3, offset: 3 }))).toEqual([
        'e3',
        'e2',
        'e1',
      ]);
      expect(ids(await h.store.list(undefined, undefined, { limit: 3, offset: 6 }))).toEqual([
        'e0',
      ]);
      expect(await h.store.list(undefined, undefined, { offset: 50 })).toEqual([]);
    });

    test('defaults to 100 and refuses a page outside 1 to 1000', async () => {
      const batch = Array.from({ length: 105 }, (_, i) => seed(h, `e${i}`, { createdAt: T0 + i }));
      await Promise.all(batch);
      expect((await h.store.list()).length).toBe(100);
      for (const options of [
        { limit: 0 },
        { limit: 1001 },
        { limit: 1.5 },
        { offset: -1 },
        { offset: 0.5 },
      ]) {
        await expect(h.store.list(undefined, undefined, options)).rejects.toThrow(RangeError);
      }
    });
  });

  describe('listActive', () => {
    test('is the runs of that workflow whose definition must stay, oldest progress first', async () => {
      const of = (id: string, over: Partial<Execution>) => seed(h, id, { updatedAt: T0, ...over });
      await of('run', { state: 'running', updatedAt: T0 + 5 });
      await of('wait', { state: 'waiting', updatedAt: T0 + 1 });
      await of('comp', { state: 'compensating', updatedAt: T0 + 3 });
      await of('stuck', { state: 'compensation-stuck', updatedAt: T0 + 2 });
      await of('failed-open', { state: 'failed', updatedAt: T0 + 4 });
      await of('failed-done', { state: 'failed', rollbackStatus: 'completed' });
      await of('failed-na', { state: 'failed', rollbackStatus: 'not-applicable' });
      await of('done', { state: 'completed' });
      await of('other', { state: 'running', workflowName: 'other' });
      expect(ids(await h.store.listActive('order'))).toEqual([
        'wait',
        'stuck',
        'comp',
        'failed-open',
        'run',
      ]);
    });
  });

  describe('listRecoverable', () => {
    const of = (id: string, over: Partial<Execution>) => seed(h, id, { updatedAt: T0, ...over });

    test('is the runs recovery may drive, oldest progress first', async () => {
      await of('run', { state: 'running', updatedAt: T0 + 3 });
      await of('wait', { state: 'waiting', updatedAt: T0 + 1 });
      await of('comp', { state: 'compensating', updatedAt: T0 + 2 });
      await of('failed-open', { state: 'failed', updatedAt: T0 + 2 });
      await of('stuck', { state: 'compensation-stuck' });
      await of('failed-done', { state: 'failed', rollbackStatus: 'stuck' });
      await of('done', { state: 'completed' });
      expect(ids(await h.store.listRecoverable())).toEqual(['wait', 'comp', 'failed-open', 'run']);
    });

    test('leaves a child to its parent, unless the parent is gone', async () => {
      await of('parent', { state: 'waiting', updatedAt: T0 + 1 });
      await of('child', { state: 'running', parentExecutionId: 'parent', updatedAt: T0 + 2 });
      await of('orphan', { state: 'running', parentExecutionId: 'removed', updatedAt: T0 + 3 });
      expect(ids(await h.store.listRecoverable())).toEqual(['parent', 'orphan']);
      await h.store.remove('parent');
      expect(ids(await h.store.listRecoverable())).toEqual(['child', 'orphan']);
    });

    test('with idleMs skips what moved recently, inclusive at the edge', async () => {
      await of('old', { state: 'running', updatedAt: T0 - 1000 });
      await of('edge', { state: 'running', updatedAt: T0 - 500 });
      await of('fresh', { state: 'running', updatedAt: T0 - 499 });
      expect(ids(await h.store.listRecoverable({ idleMs: 500 }))).toEqual(['old', 'edge']);
      expect(ids(await h.store.listRecoverable({ idleMs: 0 }))).toEqual(['old', 'edge', 'fresh']);
    });

    test('stops at the limit, keeping the oldest, and refuses a limit outside its bounds', async () => {
      for (let i = 0; i < 5; i++) await of(`e${i}`, { updatedAt: T0 + 10 - i });
      expect(ids(await h.store.listRecoverable({ limit: 2 }))).toEqual(['e4', 'e3']);
      for (const options of [
        { limit: 0 },
        { limit: 10_001 },
        { idleMs: -1 },
        { idleMs: Number.NaN },
      ]) {
        await expect(h.store.listRecoverable(options)).rejects.toThrow(RangeError);
      }
    });

    test('takes only the states it is asked for, so parked runs cannot crowd out the rest', async () => {
      await of('w1', { state: 'waiting', updatedAt: T0 + 1 });
      await of('w2', { state: 'waiting', updatedAt: T0 + 2 });
      await of('r1', { state: 'running', updatedAt: T0 + 3 });
      await of('c0', { state: 'compensating', updatedAt: T0 + 4 });
      const states = ['running', 'compensating', 'failed'] as const;
      expect(ids(await h.store.listRecoverable({ states, limit: 1 }))).toEqual(['r1']);
      expect(ids(await h.store.listRecoverable({ states }))).toEqual(['r1', 'c0']);
      expect(ids(await h.store.listRecoverable({ states: ['waiting'] }))).toEqual(['w1', 'w2']);
      expect(await h.store.listRecoverable({ states: [] })).toEqual([]);
    });

    test('refuses a state that recovery never drives', async () => {
      await expect(h.store.listRecoverable({ states: ['completed'] })).rejects.toThrow(TypeError);
      await expect(h.store.listRecoverable({ states: ['compensation-stuck'] })).rejects.toThrow(
        TypeError
      );
    });

    test('takes the best of every state, not the first of one', async () => {
      await of('w1', { state: 'waiting', updatedAt: T0 + 1 });
      await of('w2', { state: 'waiting', updatedAt: T0 + 2 });
      await of('r1', { state: 'running', updatedAt: T0 + 3 });
      await of('c0', { state: 'compensating', updatedAt: T0 });
      expect(ids(await h.store.listRecoverable({ limit: 3 }))).toEqual(['c0', 'w1', 'w2']);
    });
  });
}
