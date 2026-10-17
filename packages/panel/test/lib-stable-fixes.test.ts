import { afterEach, describe, expect, test } from 'bun:test';
import type { AlertRule } from '../src/components/dashboard/stores/alertsStore';
import { alertMetricValue, parseAlertQueueSummary } from '../src/lib/alertEngineMetrics';
import { bq } from '../src/lib/bq';
import {
  encodedAddJobRequest,
  encodedBulkJobRequest,
  FLOW_METADATA_KEYS,
} from '../src/lib/bq/jobPayload';
import type { JobFull } from '../src/lib/bqTypes';
import { buildCloneState } from '../src/lib/cloneJob';

// Regression tests for verified defects: cloned flow children kept broker-owned
// flow links, and the "waiting" alert ignored Qelay's `prioritized` split.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const flowMetadata = {
  __parentId: 'parent-1',
  __parentQueue: 'orders',
  __childrenIds: ['child-9'],
  __flowParentId: 'flow-parent',
  __flowParentIds: ['flow-a', 'flow-b'],
};

describe('cloning a flow job', () => {
  test('mirrors the exact broker-owned key list Qelay protects', () => {
    expect([...FLOW_METADATA_KEYS]).toEqual(Object.keys(flowMetadata));
  });

  test('strips every flow metadata key and keeps the user payload', () => {
    const state = buildCloneState({
      id: 'child-1',
      queue: 'shipping',
      state: 'completed',
      parentId: 'parent-1',
      data: { sku: 'x-1', nested: { __parentId: 'user-owned' }, __custom: 1, ...flowMetadata },
    } as unknown as JobFull);
    const data = JSON.parse(state.clone.dataText) as Record<string, unknown>;
    expect(data).toEqual({ sku: 'x-1', nested: { __parentId: 'user-owned' }, __custom: 1 });
    // The cloned text is accepted by the add-job backstop below.
    expect(() => encodedAddJobRequest({ name: 'n', data })).not.toThrow();
  });

  test('leaves non-object data untouched', () => {
    const job = (data: unknown) =>
      ({ id: 'j', queue: 'q', state: 'waiting', data }) as unknown as JobFull;
    expect(JSON.parse(buildCloneState(job([1, 2])).clone.dataText)).toEqual([1, 2]);
    expect(JSON.parse(buildCloneState(job('text')).clone.dataText)).toBe('text');
    expect(JSON.parse(buildCloneState(job(undefined)).clone.dataText)).toEqual({});
  });
});

describe('add-job validation rejects forged flow metadata', () => {
  test('single add names each reserved key and never reaches the network', async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(Response.json({ ok: true, id: 'x' }));
    }) as unknown as typeof fetch;
    expect(() =>
      encodedAddJobRequest({ name: 'n', data: { ok: 1, __parentId: 'p', __parentQueue: 'q' } })
    ).toThrow(/flow metadata: __parentId, __parentQueue/);
    await expect(bq.addJob('q', { name: 'n', data: { __childrenIds: [] } })).rejects.toThrow(
      '__childrenIds'
    );
    expect(calls).toBe(0);
  });

  test('bulk add reports the offending job index', () => {
    expect(() =>
      encodedBulkJobRequest([
        { name: 'a', data: { fine: true } },
        { name: 'b', data: { __flowParentIds: ['p'] } },
      ])
    ).toThrow(/^Bulk job 2: Job data must not contain broker-owned flow metadata: __flowParentIds/);
  });

  test('ordinary, nested, array and non-reserved underscore data still pass', () => {
    for (const data of [
      { __custom: 1 },
      { nested: { __parentId: 'p' } },
      [{ __parentId: 'p' }],
      'plain',
      null,
    ]) {
      expect(() => encodedAddJobRequest({ name: 'n', data })).not.toThrow();
      expect(() => encodedBulkJobRequest([{ name: 'n', data }])).not.toThrow();
    }
  });
});

const rule = (over: Partial<AlertRule>): AlertRule => ({
  id: 'r1',
  name: 'backlog',
  metric: 'waiting',
  operator: '>=',
  threshold: 5,
  queue: '',
  channel: 'email',
  enabled: true,
  ...over,
});

const row = (name: string, waiting: number, prioritized: number, failed = 0) => ({
  name,
  paused: false,
  counts: { waiting, prioritized, active: 0, completed: 0, failed, delayed: 0 },
});

describe('waiting alert metric', () => {
  const summary = parseAlertQueueSummary([row('emails', 2, 7, 1), row('images', 3, 0, 4)]);
  const ctx = { summary, queues: null, overview: null };

  test('counts prioritized runnable jobs per queue and globally', () => {
    expect(summary).not.toBeNull();
    expect(alertMetricValue(rule({ queue: 'emails' }), ctx)).toBe(9);
    expect(alertMetricValue(rule({ queue: 'images' }), ctx)).toBe(3);
    expect(alertMetricValue(rule({}), ctx)).toBe(12);
    expect(alertMetricValue(rule({ queue: 'missing' }), ctx)).toBeNull();
  });

  test('the failed metric is unchanged', () => {
    expect(alertMetricValue(rule({ metric: 'failed', queue: 'emails' }), ctx)).toBe(1);
    expect(alertMetricValue(rule({ metric: 'failed' }), ctx)).toBe(5);
  });

  test('requires prioritized like the bq summary parser', () => {
    const { prioritized: _omitted, ...counts } = row('emails', 2, 7).counts;
    expect(parseAlertQueueSummary([{ name: 'emails', paused: false, counts }])).toBeNull();
    expect(parseAlertQueueSummary([row('emails', 2, -1)])).toBeNull();
  });
});
