import { describe, expect, test } from 'bun:test';
import type { Ring, RingItem, RingResult, RungEntry } from '@qelay-cloud/core';
import { ringDue } from '../src/ring';
import { recordedTelemetry } from './support';

const ring = (jobId: string, dueInMs = 0, queue = 'q'): Ring => ({
  bell: { namespace: 'n', queue, jobId },
  dueInMs,
});

function rig(options: {
  maxRingBatch?: number;
  answer?: (item: RingItem, n: number) => RingResult;
  markFails?: boolean;
  throwOnRing?: number[];
}) {
  const calls: RingItem[][] = [];
  const marked: RungEntry[][] = [];
  const telemetry = recordedTelemetry();
  let call = 0;
  const transport = {
    capabilities: {
      maxDeliverDelayMs: Number.POSITIVE_INFINITY,
      maxRingBatch: options.maxRingBatch ?? 1_000,
      attemptCount: 'none' as const,
      retryGranularityMs: 1,
    },
    async ring(items: readonly RingItem[]): Promise<RingResult[]> {
      calls.push([...items]);
      if (options.throwOnRing?.includes(call++)) throw new Error('boom');
      return items.map((item, n) => options.answer?.(item, n) ?? { ok: true });
    },
  };
  const store = {
    async markRung(entries: readonly RungEntry[]) {
      marked.push([...entries]);
      if (options.markFails) throw new Error('database down');
    },
  };
  return { calls, marked, telemetry, deps: { store, transport, telemetry } };
}

describe('ringDue', () => {
  test('rings in batches of the transport size and reports each taken bell with its relative delay', async () => {
    const r = rig({ maxRingBatch: 2 });
    const report = await ringDue(r.deps, [ring('a', 0), ring('b', 1_500), ring('c', 250)]);
    expect(r.calls.map((batch) => batch.map((item) => item.bell.jobId))).toEqual([
      ['a', 'b'],
      ['c'],
    ]);
    expect(r.marked).toEqual([
      [
        { jobId: 'a', deliverAfterMs: 0 },
        { jobId: 'b', deliverAfterMs: 1_500 },
      ],
      [{ jobId: 'c', deliverAfterMs: 250 }],
    ]);
    expect(report).toEqual({
      due: 3,
      rung: 3,
      deferred: 0,
      rejected: 0,
      unreachable: 0,
      unmarked: 0,
      skipped: 0,
    });
  });

  test('a delay is rounded up, so a bell is never early', async () => {
    const r = rig({});
    await ringDue(r.deps, [ring('a', 10.2)]);
    expect(r.calls[0]![0]!.deliverAfterMs).toBe(11);
    expect(r.marked[0]).toEqual([{ jobId: 'a', deliverAfterMs: 11 }]);
  });

  test('markRung hears only of the bells the broker took', async () => {
    const r = rig({
      answer: (item) =>
        item.bell.jobId === 'b'
          ? { ok: false, reason: 'rejected' }
          : item.bell.jobId === 'c'
            ? { ok: false, reason: 'delay-too-long' }
            : { ok: true },
    });
    const report = await ringDue(r.deps, [ring('a'), ring('b'), ring('c'), ring('d')]);
    expect(r.marked).toEqual([
      [
        { jobId: 'a', deliverAfterMs: 0 },
        { jobId: 'd', deliverAfterMs: 0 },
      ],
    ]);
    expect(report).toMatchObject({ rung: 2, rejected: 1, deferred: 1, unreachable: 0, skipped: 0 });
  });

  test('an unreachable broker ends the step: the batches after it are not attempted', async () => {
    const r = rig({
      maxRingBatch: 2,
      answer: (item) =>
        item.bell.jobId === 'b' ? { ok: false, reason: 'unreachable' } : { ok: true },
    });
    const report = await ringDue(r.deps, [ring('a'), ring('b'), ring('c'), ring('d'), ring('e')]);
    expect(r.calls).toHaveLength(1);
    expect(r.marked).toEqual([[{ jobId: 'a', deliverAfterMs: 0 }]]);
    expect(report).toEqual({
      due: 5,
      rung: 1,
      deferred: 0,
      rejected: 0,
      unreachable: 1,
      unmarked: 0,
      skipped: 3,
    });
  });

  test('a transport that throws is an unreachable broker, and nothing is marked', async () => {
    const r = rig({ throwOnRing: [0] });
    const report = await ringDue(r.deps, [ring('a'), ring('b')]);
    expect(r.marked).toEqual([]);
    expect(report).toMatchObject({ due: 2, rung: 0, unreachable: 2, skipped: 0 });
    expect(r.telemetry.errors.map(([step]) => step)).toEqual(['ring']);
  });

  test('a transport that answers for fewer items than it was given leaves the rest unreachable', async () => {
    const r = rig({});
    const short = {
      ...r.deps,
      transport: { ...r.deps.transport, ring: async () => [{ ok: true } as const] },
    };
    const report = await ringDue(short, [ring('a'), ring('b'), ring('c')]);
    expect(r.marked).toEqual([[{ jobId: 'a', deliverAfterMs: 0 }]]);
    expect(report).toMatchObject({ rung: 1, unreachable: 2 });
  });

  test('a markRung that fails is reported as unmarked, not as rung, and ends the step', async () => {
    const r = rig({ maxRingBatch: 1, markFails: true });
    const report = await ringDue(r.deps, [ring('a'), ring('b')]);
    expect(report).toEqual({
      due: 2,
      rung: 0,
      deferred: 0,
      rejected: 0,
      unreachable: 0,
      unmarked: 1,
      skipped: 1,
    });
    expect(r.telemetry.errors.map(([step]) => step)).toEqual(['mark']);
  });

  test('nothing due means no call at all', async () => {
    const r = rig({});
    expect(await ringDue(r.deps, [])).toMatchObject({ due: 0, rung: 0 });
    expect(r.calls).toEqual([]);
    expect(r.marked).toEqual([]);
  });

  test('a bell with no job id is rung and not recorded: there is no row to mark', async () => {
    const r = rig({});
    const report = await ringDue(r.deps, [{ bell: { namespace: 'n', queue: 'q' }, dueInMs: 0 }]);
    expect(report.rung).toBe(1);
    expect(r.marked).toEqual([]);
  });
});
