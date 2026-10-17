import { describe, expect, test } from 'bun:test';
import { GroupFullError } from '../src/errors';
import type { ExistingRow } from '../src/store/lookup';
import { keyOf } from '../src/store/lookup';
import type { PlanInput } from '../src/store/plan';
import { planAdmission } from '../src/store/plan';
import type { PreparedJob } from '../src/store/prepare';

const NOW = 1_000_000;

const job = (index: number, extra: Partial<PreparedJob> = {}): PreparedJob => ({
  index,
  customId: null,
  queue: 'q',
  payload: new Uint8Array([index]),
  priority: 0,
  lifo: false,
  delayMs: 0,
  maxAttempts: 1,
  timeout: null,
  dedupKey: null,
  dedupTtl: null,
  dedupExtend: false,
  dedupReplace: false,
  groupId: null,
  groupMaxSize: null,
  ...extra,
});

const row = (id: string, extra: Partial<ExistingRow> = {}): ExistingRow => ({
  id,
  queue: 'q',
  state: 'waiting',
  runAt: NOW - 10,
  priority: 0,
  groupId: null,
  uniqueKey: null,
  uniqueExpiresAt: null,
  ...extra,
});

function plan(
  jobs: PreparedJob[],
  existing: ExistingRow[] = [],
  pending: Array<[string, number]> = []
) {
  let next = 0;
  const input: PlanInput = {
    now: NOW,
    jobs,
    existingById: new Map(existing.map((r) => [r.id, r])),
    existingByKey: new Map(
      existing.filter((r) => r.uniqueKey !== null).map((r) => [keyOf(r.queue, r.uniqueKey!), r])
    ),
    pendingByGroup: new Map(pending),
    nextId: () => `gen-${next++}`,
  };
  return planAdmission(input);
}

describe('enqueue: planAdmission', () => {
  test('new jobs get generated ids in input order and an event each', () => {
    const result = plan([job(0), job(1, { priority: 2 }), job(2, { delayMs: 50 })]);
    expect(result.inserts.map((i) => [i.id, i.state, i.runAt])).toEqual([
      ['gen-0', 'waiting', NOW],
      ['gen-1', 'prioritized', NOW],
      ['gen-2', 'delayed', NOW + 50],
    ]);
    expect(result.events.map((e) => e.type)).toEqual(['pushed', 'pushed', 'pushed']);
    expect(result.admitted.map((a) => a.kind)).toEqual(['created', 'created', 'created']);
  });

  test('a custom id is the job id and uses no generated id', () => {
    const result = plan([job(0, { customId: 'mine' }), job(1)]);
    expect(result.inserts.map((i) => i.id)).toEqual(['mine', 'gen-0']);
  });

  describe('custom ids', () => {
    test.each(['waiting', 'prioritized', 'delayed', 'waiting-children', 'active'])(
      'a %s job with the id is a duplicate',
      (state) => {
        const result = plan([job(0, { customId: 'x' })], [row('x', { state })]);
        expect(result.inserts).toEqual([]);
        expect(result.admitted[0]).toMatchObject({ kind: 'duplicate', id: 'x' });
        expect(result.events).toEqual([
          { type: 'duplicated', queue: 'q', jobId: 'x', state: expect.any(String) },
        ]);
      }
    );

    test('a stored delayed job past its run time is a duplicate in the claimable state', () => {
      const result = plan(
        [job(0, { customId: 'x' })],
        [row('x', { state: 'delayed', runAt: NOW })]
      );
      expect(result.admitted[0]).toMatchObject({ kind: 'duplicate', state: 'waiting' });
      const high = plan(
        [job(0, { customId: 'x' })],
        [row('x', { state: 'delayed', runAt: NOW - 1, priority: 4 })]
      );
      expect(high.admitted[0]).toMatchObject({ state: 'prioritized' });
      const early = plan(
        [job(0, { customId: 'x' })],
        [row('x', { state: 'delayed', runAt: NOW + 1 })]
      );
      expect(early.admitted[0]).toMatchObject({ state: 'delayed' });
    });

    test.each(['completed', 'failed'])('a %s job with the id is deleted and replaced', (state) => {
      const result = plan([job(0, { customId: 'x' })], [row('x', { state })]);
      expect(result.deleteIds).toEqual(['x']);
      expect(result.inserts.map((i) => i.id)).toEqual(['x']);
    });

    test('the second job of one id in a call is the duplicate of the first', () => {
      const result = plan([job(0, { customId: 'x' }), job(1, { customId: 'x' })]);
      expect(result.admitted.map((a) => a.kind)).toEqual(['created', 'duplicate']);
      expect(result.inserts).toHaveLength(1);
    });
  });

  describe('dedup keys', () => {
    const holder = (extra: Partial<ExistingRow> = {}) => row('h', { uniqueKey: 'k', ...extra });
    const keyed = (extra: Partial<PreparedJob> = {}) => job(0, { dedupKey: 'k', ...extra });

    test('a live holder answers the job', () => {
      const result = plan([keyed()], [holder()]);
      expect(result.admitted[0]).toMatchObject({ kind: 'duplicate', id: 'h' });
      expect(result.inserts).toEqual([]);
    });

    test('a holder expires exactly at its expiry time', () => {
      const last = plan([keyed()], [holder({ uniqueExpiresAt: NOW + 1 })]);
      expect(last.admitted[0]!.kind).toBe('duplicate');
      const expired = plan([keyed()], [holder({ uniqueExpiresAt: NOW })]);
      expect(expired.admitted[0]!.kind).toBe('created');
      expect(expired.clearKeyIds).toEqual(['h']);
      expect(expired.deleteIds).toEqual([]);
      expect(expired.events.map((e) => e.type)).toEqual(['updated', 'pushed']);
    });

    test('a holder without an expiry never expires', () => {
      expect(plan([keyed()], [holder({ uniqueExpiresAt: null })]).admitted[0]!.kind).toBe(
        'duplicate'
      );
    });

    test('extend moves the window of a stored holder, and needs a ttl', () => {
      const moved = plan(
        [keyed({ dedupExtend: true, dedupTtl: 500 })],
        [holder({ uniqueExpiresAt: NOW + 10 })]
      );
      expect([...moved.extend]).toEqual([['h', NOW + 500]]);
      const nothing = plan([keyed({ dedupExtend: true })], [holder({ uniqueExpiresAt: NOW + 10 })]);
      expect(nothing.extend.size).toBe(0);
    });

    test('a new job takes its window from its ttl', () => {
      const result = plan([keyed({ dedupTtl: 700 }), job(1)]);
      expect(result.inserts.map((i) => i.uniqueExpiresAt)).toEqual([NOW + 700, null]);
    });

    test('extend over a job planned in the same call edits that job and writes nothing else', () => {
      const result = plan([
        keyed({ dedupTtl: 100 }),
        job(1, { dedupKey: 'k', dedupTtl: 900, dedupExtend: true }),
      ]);
      expect(result.inserts.map((i) => i.uniqueExpiresAt)).toEqual([NOW + 900]);
      expect(result.extend.size).toBe(0);
    });

    test('replace deletes a waiting holder and inserts the new job', () => {
      const result = plan([keyed({ dedupReplace: true })], [holder()]);
      expect(result.deleteIds).toEqual(['h']);
      expect(result.clearKeyIds).toEqual([]);
      expect(result.events.map((e) => e.type)).toEqual(['removed', 'pushed']);
      expect(result.admitted[0]!.kind).toBe('created');
    });

    test('replace releases an active holder instead of deleting it', () => {
      const result = plan([keyed({ dedupReplace: true })], [holder({ state: 'active' })]);
      expect(result.deleteIds).toEqual([]);
      expect(result.clearKeyIds).toEqual(['h']);
      expect(result.events.map((e) => e.type)).toEqual(['updated', 'pushed']);
    });

    test('an expired holder that would be extended is released, not extended', () => {
      const result = plan(
        [keyed({ dedupExtend: true, dedupTtl: 500 })],
        [holder({ uniqueExpiresAt: NOW })]
      );
      expect(result.extend.size).toBe(0);
      expect(result.clearKeyIds).toEqual(['h']);
    });

    test('replace cancels a job planned earlier in the call', () => {
      const result = plan([keyed(), job(1, { dedupKey: 'k', dedupReplace: true })]);
      expect(result.inserts.map((i) => i.job.index)).toEqual([1]);
      expect(result.deleteIds).toEqual([]);
      const first = result.admitted[0]!;
      expect(first.kind === 'created' && first.insert.cancelled).toBe(true);
      expect(result.events.map((e) => e.type)).toEqual(['pushed', 'removed', 'pushed']);
    });

    test('a replace of a stored active holder, then a plain job, makes the second a duplicate of the first', () => {
      const result = plan(
        [keyed({ dedupReplace: true }), job(1, { dedupKey: 'k' })],
        [holder({ state: 'active' })]
      );
      expect(result.admitted[1]).toMatchObject({ kind: 'duplicate', id: 'gen-0' });
    });

    test('keys are scoped to the queue', () => {
      const result = plan([job(0, { queue: 'other', dedupKey: 'k' })], [holder()]);
      expect(result.admitted[0]!.kind).toBe('created');
    });
  });

  describe('groups', () => {
    const capped = (index: number, maxSize: number) =>
      job(index, { groupId: 'g', groupMaxSize: maxSize });
    const full = (error: unknown) => error as GroupFullError;

    test('a job over the cap throws with its own position', () => {
      let thrown: unknown;
      try {
        plan([job(0), capped(1, 1), capped(2, 1)]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(GroupFullError);
      expect(full(thrown)).toMatchObject({ index: 2, groupId: 'g', maxSize: 1 });
    });

    test('jobs already stored count, and each planned job counts as it is placed', () => {
      expect(() => plan([capped(0, 3), capped(1, 3)], [], [[keyOf('q', 'g'), 1]])).not.toThrow();
      expect(() =>
        plan([capped(0, 3), capped(1, 3), capped(2, 3)], [], [[keyOf('q', 'g'), 1]])
      ).toThrow(GroupFullError);
    });

    test('a group the call does not cap is not counted', () => {
      expect(() => plan([job(0, { groupId: 'g' }), job(1, { groupId: 'g' })])).not.toThrow();
    });

    test('a replace frees the room of the job it removes', () => {
      const holder = row('h', { uniqueKey: 'k', groupId: 'g' });
      const swap = job(0, { groupId: 'g', groupMaxSize: 1, dedupKey: 'k', dedupReplace: true });
      const result = plan([swap], [holder], [[keyOf('q', 'g'), 1]]);
      expect(result.admitted[0]!.kind).toBe('created');
    });

    test('a replace of an active holder frees nothing', () => {
      const holder = row('h', { uniqueKey: 'k', groupId: 'g', state: 'active' });
      const swap = job(0, { groupId: 'g', groupMaxSize: 1, dedupKey: 'k', dedupReplace: true });
      expect(() => plan([swap], [holder], [[keyOf('q', 'g'), 0]])).not.toThrow();
      expect(() => plan([swap, capped(1, 1)], [holder], [[keyOf('q', 'g'), 0]])).toThrow(
        GroupFullError
      );
    });
  });
});
