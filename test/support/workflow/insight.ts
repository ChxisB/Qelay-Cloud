import { describe, expect, test } from 'bun:test';
import type { WorkflowDefinitionInput } from '../../../packages/core/src';
import type { WorkflowHarness } from './fixtures';
import { moveTo, seed, T0 } from './fixtures';

const DAY = 24 * 60 * 60 * 1000;

const definition = (name: string, hash: string): WorkflowDefinitionInput => ({
  name,
  hash,
  revision: 'r1',
  graph: [
    { type: 'step', step: { name: 'charge', retry: 3, timeout: 5000, compensates: true } },
    { type: 'waitFor', event: 'approved', timeout: 60_000 },
    { type: 'pivot' },
    {
      type: 'forEach',
      maxIterations: 50,
      step: { name: 'ship', retry: 1, timeout: 1000, compensates: false },
    },
  ],
});

export function insightContract(h: WorkflowHarness): void {
  describe('definitions', () => {
    test('are stored with their graph and the times they were seen', async () => {
      const input = definition('order', 'h1');
      await h.store.recordDefinition(input);
      expect(await h.store.listDefinitions()).toEqual([
        { ...input, firstSeenAt: T0, lastSeenAt: T0 },
      ]);
    });

    test('announced again only move lastSeenAt', async () => {
      await h.store.recordDefinition(definition('order', 'h1'));
      h.clock.advance(5000);
      await h.store.recordDefinition({ ...definition('order', 'h1'), revision: 'ignored' });
      const [row] = await h.store.listDefinitions();
      expect(row).toMatchObject({ revision: 'r1', firstSeenAt: T0, lastSeenAt: T0 + 5000 });
    });

    test('list by name, newest announcement first', async () => {
      await h.store.recordDefinition(definition('order', 'h1'));
      h.clock.advance(10);
      await h.store.recordDefinition(definition('refund', 'r1'));
      h.clock.advance(10);
      await h.store.recordDefinition(definition('order', 'h2'));
      const all = await h.store.listDefinitions();
      expect(all.map((d) => `${d.name}/${d.hash}`)).toEqual(['order/h2', 'order/h1', 'refund/r1']);
      const order = await h.store.listDefinitions({ name: 'order' });
      expect(order.map((d) => d.hash)).toEqual(['h2', 'h1']);
      expect(await h.store.listDefinitions({ name: 'none' })).toEqual([]);
    });

    test('a new hash forgets old ones beyond the newest twenty, and only those', async () => {
      for (let i = 0; i < 22; i++) {
        await h.store.recordDefinition(definition('order', `h${i}`));
        h.clock.advance(2 * DAY);
      }
      // the other workflow is as old, but nothing of its own has arrived since
      await h.store.recordDefinition(definition('refund', 'old'));
      h.clock.advance(100 * DAY);
      await h.store.recordDefinition(definition('order', 'h22'));
      const order = await h.store.listDefinitions({ name: 'order' });
      expect(order[0]!.hash).toBe('h22');
      expect(order.length).toBe(20);
      expect((await h.store.listDefinitions({ name: 'refund' })).map((d) => d.hash)).toEqual([
        'old',
      ]);
    });

    test('a refresh never forgets anything', async () => {
      await h.store.recordDefinition(definition('order', 'h1'));
      h.clock.advance(100 * DAY);
      await h.store.recordDefinition(definition('order', 'h1'));
      expect(await h.store.listDefinitions()).toHaveLength(1);
    });

    test('refuse a name, hash or graph no store should keep', async () => {
      const ok = definition('order', 'h1');
      await expect(h.store.recordDefinition({ ...ok, name: '' })).rejects.toThrow(TypeError);
      await expect(h.store.recordDefinition({ ...ok, hash: '' })).rejects.toThrow(TypeError);
      await expect(h.store.recordDefinition({ ...ok, name: 'a\0b' })).rejects.toThrow(TypeError);
      await expect(
        h.store.recordDefinition({ ...ok, graph: {} as unknown as never[] })
      ).rejects.toThrow(TypeError);
      const huge = [{ type: 'map', name: 'x'.repeat(1024 * 1024) }] as const;
      await expect(h.store.recordDefinition({ ...ok, graph: huge })).rejects.toThrow(RangeError);
      expect(await h.store.listDefinitions()).toEqual([]);
    });
  });

  describe('summaries', () => {
    test('are the scalar fields of each run, newest first', async () => {
      const a = await seed(h, 'a', { createdAt: T0 + 1, definitionHash: 'h1' });
      await seed(h, 'b', {
        createdAt: T0 + 2,
        parentExecutionId: 'a',
        steps: { s: { status: 'completed', result: 'x'.repeat(1000) } },
      });
      await moveTo(h, 'a', {
        state: 'failed',
        failureReason: 'boom',
        rollbackStatus: 'stuck',
        committedAt: 2,
        currentNodeIndex: 3,
      });
      const list = await h.store.summaries();
      expect(list.map((s) => s.id)).toEqual(['b', 'a']);
      expect(list[0]).toEqual({
        id: 'b',
        workflowName: 'order',
        state: 'running',
        parentExecutionId: 'a',
        currentNodeIndex: 0,
        version: 0,
        createdAt: T0 + 2,
        updatedAt: T0,
      });
      expect(list[1]).toMatchObject({
        id: 'a',
        state: 'failed',
        definitionHash: 'h1',
        failureReason: 'boom',
        rollbackStatus: 'stuck',
        committedAt: 2,
        currentNodeIndex: 3,
        version: a.version! + 1,
      });
      expect(Object.keys(list[0]!)).not.toContain('steps');
      expect(Object.keys(list[0]!)).not.toContain('input');
    });

    test('filter and page the way list does', async () => {
      await seed(h, 'a', { workflowName: 'x', state: 'running', createdAt: T0 + 1 });
      await seed(h, 'b', { workflowName: 'x', state: 'completed', createdAt: T0 + 2 });
      await seed(h, 'c', { workflowName: 'y', state: 'running', createdAt: T0 + 3 });
      const of = async (options: Parameters<typeof h.store.summaries>[0]) =>
        (await h.store.summaries(options)).map((s) => s.id);
      expect(await of({ workflowName: 'x' })).toEqual(['b', 'a']);
      expect(await of({ state: 'running' })).toEqual(['c', 'a']);
      expect(await of({ workflowName: 'x', state: 'running' })).toEqual(['a']);
      expect(await of({ id: 'b' })).toEqual(['b']);
      expect(await of({ id: 'b', state: 'running' })).toEqual([]);
      expect(await of({ id: 'none' })).toEqual([]);
      expect(await of({ limit: 1, offset: 1 })).toEqual(['b']);
      expect(await of({ workflowName: 'z' })).toEqual([]);
      for (const options of [{ limit: 0 }, { limit: 1001 }, { offset: -1 }]) {
        await expect(h.store.summaries(options)).rejects.toThrow(RangeError);
      }
    });

    test('show what a parked run waits for, and drop it once the run moves on', async () => {
      await seed(h, 'w');
      await seed(h, 'n');
      await h.store.parkForSignal('w', 'approved', T0 + 5000);
      await h.store.parkForSignal('n', 'nudge');
      const parked = Object.fromEntries((await h.store.summaries()).map((s) => [s.id, s]));
      expect(parked['w']).toMatchObject({
        state: 'waiting',
        waitEvent: 'approved',
        waitDeadlineAt: T0 + 5000,
      });
      expect(parked['n']).toMatchObject({ state: 'waiting', waitEvent: 'nudge' });
      expect(Object.keys(parked['n']!)).not.toContain('waitDeadlineAt');
      await h.store.recordSignal('w', 'approved', 1);
      const after = (await h.store.summaries({ state: 'running' })).find((s) => s.id === 'w');
      expect(after).toBeDefined();
      expect(Object.keys(after!)).not.toContain('waitEvent');
    });
  });

  describe('counts', () => {
    test('are the runs per workflow and state, and nothing for what has none', async () => {
      expect(await h.store.counts()).toEqual([]);
      await seed(h, 'a', { workflowName: 'x', state: 'running' });
      await seed(h, 'b', { workflowName: 'x', state: 'running' });
      await seed(h, 'c', { workflowName: 'x', state: 'failed' });
      await seed(h, 'd', { workflowName: 'y', state: 'completed' });
      expect(await h.store.counts()).toEqual([
        { workflowName: 'x', state: 'failed', count: 1 },
        { workflowName: 'x', state: 'running', count: 2 },
        { workflowName: 'y', state: 'completed', count: 1 },
      ]);
    });
  });

  describe('liveDefinitions', () => {
    test('are the live runs per workflow and hash, and nothing for finished ones', async () => {
      expect(await h.store.liveDefinitions()).toEqual([]);
      await seed(h, 'a', { workflowName: 'x', state: 'running', definitionHash: 'h2' });
      await seed(h, 'b', { workflowName: 'x', state: 'running', definitionHash: 'h2' });
      await seed(h, 'c', { workflowName: 'x', state: 'compensating', definitionHash: 'h1' });
      await seed(h, 'd', { workflowName: 'x', state: 'completed', definitionHash: 'h3' });
      await seed(h, 'e', { workflowName: 'y', state: 'running' });
      await seed(h, 'f', { workflowName: 'y', state: 'failed', definitionHash: 'h9' });
      expect(await h.store.liveDefinitions()).toEqual([
        { workflowName: 'x', definitionHash: 'h1', count: 1 },
        { workflowName: 'x', definitionHash: 'h2', count: 2 },
        { workflowName: 'y', count: 1 },
      ]);
    });

    test('follow a run as it moves in and out of a live state', async () => {
      await seed(h, 'a', { workflowName: 'x', state: 'running', definitionHash: 'h1' });
      await moveTo(h, 'a', { state: 'completed' });
      expect(await h.store.liveDefinitions()).toEqual([]);
    });

    test('count a parked run and a stuck unwind as live', async () => {
      await seed(h, 'a', { workflowName: 'x', state: 'waiting', definitionHash: 'h1' });
      await seed(h, 'b', { workflowName: 'x', state: 'compensation-stuck', definitionHash: 'h1' });
      expect(await h.store.liveDefinitions()).toEqual([
        { workflowName: 'x', definitionHash: 'h1', count: 2 },
      ]);
    });
  });
}
