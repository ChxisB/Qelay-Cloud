import { describe, expect, test } from 'bun:test';
import {
  ExecutionExistsError,
  ExecutionStaleError,
  type Execution,
} from '../../../packages/core/src';
import type { WorkflowHarness } from './fixtures';
import { execution, ids, moveTo, seed, T0 } from './fixtures';

export function crudContract(h: WorkflowHarness): void {
  describe('now', () => {
    test("is the store's clock, and moves with it", async () => {
      expect(await h.store.now()).toBe(h.clock.now());
      h.clock.advance(1500);
      expect(await h.store.now()).toBe(T0 + 1500);
    });
  });

  describe('save, get and remove', () => {
    test('a saved execution reads back as it was, at version 0', async () => {
      const exec = execution(h.clock, 'e1');
      await h.store.save(exec);
      expect(exec.version).toBe(0);
      expect(await h.store.get('e1')).toStrictEqual({ ...exec, version: 0 });
    });

    test('every optional field survives, and a value the codec keeps as is stays as it was', async () => {
      const when = new Date(1_800_000_000_123);
      const exec = execution(h.clock, 'e1', {
        input: { when, tags: new Set(['a', 'b']), none: undefined, big: 12345678901234567890n },
        steps: {
          a: {
            status: 'completed',
            result: { map: new Map([[1, 'x']]) },
            attempts: 2,
            loopIndex: 0,
          },
        },
        resolvedSteps: ['a', 'b'],
        decisions: { 'branch:1': 'left' },
        definitionHash: 'abc123',
        rollbackStatus: 'completed',
        failureReason: 'boom',
        committedAt: 3,
        parentExecutionId: 'parent',
        currentNodeIndex: 4,
        state: 'failed',
      });
      await h.store.save(exec);
      expect(await h.store.get('e1')).toStrictEqual({ ...exec, version: 0 });
    });

    test('an execution that was not given the optional fields does not get them back', async () => {
      await h.store.save(execution(h.clock, 'e1'));
      const stored = (await h.store.get('e1'))!;
      for (const key of [
        'resolvedSteps',
        'decisions',
        'definitionHash',
        'rollbackStatus',
        'failureReason',
        'committedAt',
        'parentExecutionId',
      ]) {
        expect(Object.hasOwn(stored, key)).toBe(false);
      }
    });

    test('an id that is taken is refused and the first execution stays', async () => {
      await h.store.save(execution(h.clock, 'e1', { input: 'first' }));
      const again = h.store.save(execution(h.clock, 'e1', { input: 'second' }));
      await expect(again).rejects.toBeInstanceOf(ExecutionExistsError);
      expect((await h.store.get('e1'))!.input).toBe('first');
    });

    test('save is for new executions: one that carries signals is refused', async () => {
      const exec = execution(h.clock, 'e1', { signals: { approved: true } });
      await expect(h.store.save(exec)).rejects.toThrow('for new executions only');
      expect(await h.store.get('e1')).toBeNull();
    });

    test('get is null for an id that was never saved, and what it returns is a copy', async () => {
      expect(await h.store.get('nope')).toBeNull();
      await seed(h, 'e1');
      const copy = (await h.store.get('e1'))!;
      copy.steps['x'] = { status: 'running' };
      expect((await h.store.get('e1'))!.steps).toEqual({});
    });

    test('remove reports whether there was an execution to remove', async () => {
      await seed(h, 'e1');
      expect(await h.store.remove('e1')).toBe(true);
      expect(await h.store.remove('e1')).toBe(false);
      expect(await h.store.get('e1')).toBeNull();
    });

    test('findChild is the first child of that parent that runs that workflow', async () => {
      await seed(h, 'p');
      await seed(h, 'c2', { parentExecutionId: 'p', workflowName: 'child', createdAt: T0 + 20 });
      await seed(h, 'c1', { parentExecutionId: 'p', workflowName: 'child', createdAt: T0 + 10 });
      await seed(h, 'other', { parentExecutionId: 'p', workflowName: 'sibling' });
      await seed(h, 'elsewhere', { parentExecutionId: 'q', workflowName: 'child' });
      expect((await h.store.findChild('p', 'child'))!.id).toBe('c1');
      expect(await h.store.findChild('p', 'missing')).toBeNull();
      expect(await h.store.findChild('nobody', 'child')).toBeNull();
    });
  });

  describe('update', () => {
    test('writes the step-level columns and the state, and moves version and updatedAt', async () => {
      const exec = await seed(h, 'e1');
      h.clock.advance(500);
      exec.steps['a'] = { status: 'completed', result: 7 };
      exec.currentNodeIndex = 1;
      exec.resolvedSteps = ['a'];
      exec.decisions = { d: 1 };
      exec.definitionHash = 'h';
      exec.committedAt = 1;
      exec.state = 'compensating';
      exec.rollbackStatus = 'stuck';
      exec.failureReason = 'why';
      await h.store.update(exec);
      expect(exec.version).toBe(1);
      expect(exec.updatedAt).toBe(h.clock.now());
      expect(await h.store.get('e1')).toStrictEqual(exec);
    });

    test('leaves the identity of the run alone: workflow, input, creation time and signals', async () => {
      const exec = await seed(h, 'e1');
      await h.store.recordSignal('e1', 'go', 1);
      exec.workflowName = 'renamed';
      exec.input = 'changed';
      exec.createdAt = 1;
      exec.signals = { forged: true };
      await h.store.update(exec);
      const stored = (await h.store.get('e1'))!;
      expect([stored.workflowName, stored.input, stored.createdAt]).toEqual([
        'order',
        { n: 1 },
        T0,
      ]);
      expect(stored.signals).toEqual({ go: 1 });
    });

    test('is refused when the row moved since this copy was read, and writes nothing', async () => {
      const first = await seed(h, 'e1');
      const second = (await h.store.get('e1'))!;
      first.steps['a'] = { status: 'completed' };
      await h.store.update(first);
      second.steps['b'] = { status: 'completed' };
      const refused = h.store.update(second).catch((error: unknown) => error);
      const error = await refused;
      expect(error).toBeInstanceOf(ExecutionStaleError);
      expect(error).toMatchObject({ executionId: 'e1', expected: 0, actual: 1 });
      expect(Object.keys((await h.store.get('e1'))!.steps)).toEqual(['a']);
    });

    test('a refused copy that reads again can write', async () => {
      const first = await seed(h, 'e1');
      await h.store.update(first);
      const stale = { ...first, version: 0 } satisfies Execution;
      await expect(h.store.update(stale)).rejects.toBeInstanceOf(ExecutionStaleError);
      const fresh = (await h.store.get('e1'))!;
      fresh.currentNodeIndex = 5;
      await h.store.update(fresh);
      expect((await h.store.get('e1'))!.currentNodeIndex).toBe(5);
    });

    test('an execution that is gone is stale, with no version to report', async () => {
      const exec = await seed(h, 'e1');
      await h.store.remove('e1');
      const error = await h.store.update(exec).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ExecutionStaleError);
      expect(error).toMatchObject({ expected: 0, actual: null });
    });

    test('needs an execution that came from the store', async () => {
      await seed(h, 'e1');
      await expect(h.store.update(execution(h.clock, 'e1'))).rejects.toThrow(TypeError);
    });

    test('a signal that arrived while the node ran is not undone by the node finishing', async () => {
      const exec = await seed(h, 'e1');
      await h.store.recordSignal('e1', 'approved', { by: 'sam' });
      exec.steps['a'] = { status: 'completed' };
      await h.store.update(exec);
      const stored = (await h.store.get('e1'))!;
      expect(stored.signals).toEqual({ approved: { by: 'sam' } });
      expect(stored.steps['a']?.status).toBe('completed');
    });

    test('writing a parked run back as running is one more version on top of the park', async () => {
      await seed(h, 'e1');
      await h.store.parkForSignal('e1', 'go');
      const parked = (await h.store.get('e1'))!;
      const resumed = await moveTo(h, 'e1', { state: 'running' });
      expect(resumed.version).toBe(parked.version! + 1);
      expect(ids(await h.store.list('order', 'running'))).toEqual(['e1']);
    });
  });
}
