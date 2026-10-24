import { describe, expect, test } from 'bun:test';
import { routeJobId, StoreError, UnsupportedOptionError } from '@qelay-cloud/core';
import type { NewJob } from '@qelay-cloud/core';
import type { Enqueue } from '../src/webhookEnqueue';
import { sendDelivery } from '../src/webhookSend';
import { delivery, script } from './webhookSupport';

const queued = (overrides = {}) =>
  delivery({ destination: 'queue', target: 'refunds', url: '', secret: null, ...overrides });

function enqueueing(answer: Enqueue = async () => [{ id: 'job-9' }]) {
  const calls: Array<readonly NewJob[]> = [];
  const enqueue: Enqueue = async (jobs) => {
    calls.push(jobs);
    return answer(jobs);
  };
  return { calls, enqueue };
}

describe('webhook attempt: a queue route adds a job', () => {
  test('one job in the target queue, named for the event, with the delivery body as its data', async () => {
    const s = script();
    const e = enqueueing();
    const result = await sendDelivery(queued(), s.deps({ enqueue: e.enqueue }));
    expect(result).toMatchObject({ ok: true, statusCode: null, error: null });
    expect(e.calls).toHaveLength(1);
    const [job] = e.calls[0]!;
    expect(job).toMatchObject({
      queue: 'refunds',
      name: 'webhook.test',
      options: { jobId: routeJobId('41') },
    });
    expect(job!.data).toMatchObject({ id: '41', event: 'webhook.test' });
    // No network and no name lookup: there is no url to check.
    expect(s.calls).toEqual([]);
    expect(s.lookups).toEqual([]);
  });

  test('the shaped body the writer stored is the job data', async () => {
    const e = enqueueing();
    await sendDelivery(
      queued({ body: JSON.stringify({ order: 'o-1', amount: 5 }) }),
      script().deps({ enqueue: e.enqueue })
    );
    expect(e.calls[0]![0]!.data).toEqual({ order: 'o-1', amount: 5 });
  });

  test('a repeated attempt names the same job, so the store can find it', async () => {
    const e = enqueueing();
    const deps = script().deps({ enqueue: e.enqueue });
    await sendDelivery(queued({ attempt: 1 }), deps);
    await sendDelivery(queued({ attempt: 2 }), deps);
    const ids = e.calls.map((call) => call[0]!.options?.jobId);
    expect(ids).toEqual([routeJobId('41'), routeJobId('41')]);
  });

  test('a refusal by the store is a failed attempt that says why', async () => {
    const e = enqueueing(async () => {
      throw new StoreError('queue is full');
    });
    const result = await sendDelivery(queued(), script().deps({ enqueue: e.enqueue }));
    expect(result).toMatchObject({ ok: false, statusCode: null });
    expect(result.error).toBe('job was not added: queue is full');
  });

  test('bad input from the store is quoted, a driver error is not', async () => {
    const bad = enqueueing(async () => {
      throw new UnsupportedOptionError('name', 'is too long');
    });
    expect((await sendDelivery(queued(), script().deps({ enqueue: bad.enqueue }))).error).toContain(
      'job was not added:'
    );
    const driver = enqueueing(async () => {
      throw new Error('duplicate key value violates unique constraint (secret-value)');
    });
    const result = await sendDelivery(queued(), script().deps({ enqueue: driver.enqueue }));
    expect(result.error).toBe('job was not added: the store failed');
  });

  test('a sender with no enqueue, a route with no target and a body too large to make all fail without a job', async () => {
    const s = script();
    const e = enqueueing();
    expect((await sendDelivery(queued(), s.deps())).error).toBe('this sender cannot add jobs');
    expect(
      (await sendDelivery(queued({ target: null }), s.deps({ enqueue: e.enqueue }))).error
    ).toBe('queue route has no target queue');
    expect((await sendDelivery(queued({ body: '' }), s.deps({ enqueue: e.enqueue }))).error).toBe(
      'shaped body was too large to make'
    );
    expect(e.calls).toEqual([]);
    expect(s.calls).toEqual([]);
  });

  test('an http route never touches enqueue', async () => {
    const s = script();
    const e = enqueueing();
    const result = await sendDelivery(delivery(), s.deps({ enqueue: e.enqueue }));
    expect(result).toMatchObject({ ok: true, statusCode: 200 });
    expect(e.calls).toEqual([]);
    expect(s.calls).toHaveLength(1);
  });
});
