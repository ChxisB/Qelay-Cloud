import { describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { RingItem } from '@qelay-cloud/core';
import { billedRequests, newMetrics, queueNames } from '../src';
import { publishBells } from '../src/publisher';
import { QueueUrls } from '../src/queueUrls';
import type { Entry } from './stub';
import { awsError, bells, stubbed } from './stub';

const ring = (count: number, deliverAfterMs?: number): RingItem[] =>
  bells(count).map((bell) => ({
    bell,
    ...(deliverAfterMs === undefined ? {} : { deliverAfterMs }),
  }));

/** `publishBells` on a virtual clock: `sleep` moves time, so a retry budget costs no real time. */
function virtual(answer: (entries: Entry[], call: number) => unknown, budgetMs = 2_000) {
  const calls: Entry[][] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const client = {
    send: async (command: { constructor: { name: string }; input: { Entries?: Entry[] } }) => {
      if (command.constructor.name === 'GetQueueUrlCommand') return { QueueUrl: 'http://stub/q' };
      calls.push(command.input.Entries ?? []);
      return await answer(command.input.Entries ?? [], calls.length - 1);
    },
  } as unknown as SQSClient;
  const metrics = newMetrics();
  const errors: unknown[] = [];
  const run = (items: RingItem[]) =>
    publishBells(
      {
        client,
        urls: new QueueUrls(client, metrics),
        namespace: 'stub',
        metrics,
        budgetMs,
        onError: (error) => errors.push(error),
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
        random: () => 1,
      },
      items
    );
  return { run, calls, sleeps, metrics, errors };
}

describe('ring with a stubbed client', () => {
  test('sends at most ten bells per call and reads the Failed list per entry', async () => {
    // Entry ids are positions within one call: id 3 of the call of ten, id 1 of the call of two.
    const { transport, calls } = stubbed(
      (entries) => {
        const failing = entries.length === 10 ? '3' : '1';
        return {
          Successful: entries
            .filter((entry) => entry.Id !== failing)
            .map((entry) => ({ Id: entry.Id })),
          Failed: [{ Id: failing, SenderFault: false, Code: 'InternalError' }],
        };
      },
      { ringRetryBudgetMs: 0 }
    );
    const results = await transport.ring(ring(12));
    expect(calls.map((call) => call.entries.length).sort((a, b) => b - a)).toEqual([10, 2]);
    const failed = results.flatMap((result, index) => (result.ok ? [] : [index]));
    expect(failed).toEqual([3, 11]);
    expect(results[3]).toEqual({ ok: false, reason: 'unreachable' });
    expect(results[0]).toEqual({ ok: true });
    expect(transport.metrics).toMatchObject({ sendCalls: 2, failedEntries: 2, sentBells: 10 });
  });

  test('an entry the sender is at fault for is rejected, once, however long the budget', async () => {
    const { transport, calls } = stubbed(
      (entries) => ({
        Successful: entries.slice(1).map((entry) => ({ Id: entry.Id })),
        Failed: [{ Id: '0', SenderFault: true, Code: 'InvalidParameterValue' }],
      }),
      { ringRetryBudgetMs: 5_000 }
    );
    const results = await transport.ring(ring(3));
    expect(results.map((result) => (result.ok ? 'ok' : result.reason))).toEqual([
      'rejected',
      'ok',
      'ok',
    ]);
    expect(calls).toHaveLength(1);
  });

  test('a call that throws fails only the bells of that call', async () => {
    const { transport } = stubbed(
      (entries) => {
        if (entries.length === 2) throw awsError('NonExistentQueue', 400);
        return { Successful: entries.map((entry) => ({ Id: entry.Id })) };
      },
      { ringRetryBudgetMs: 0 }
    );
    const results = await transport.ring(ring(12));
    expect(results.slice(0, 10).every((result) => result.ok)).toBe(true);
    expect(results.slice(10)).toEqual([
      { ok: false, reason: 'unreachable' },
      { ok: false, reason: 'unreachable' },
    ]);
  });

  test('delays are whole seconds rounded up, and absent when zero', async () => {
    const sent = async (deliverAfterMs?: number) => {
      const { transport, calls } = stubbed((entries) => ({
        Successful: entries.map((entry) => ({ Id: entry.Id })),
      }));
      await transport.ring(ring(1, deliverAfterMs));
      return calls[0]?.entries[0]?.DelaySeconds;
    };
    expect(await sent()).toBeUndefined();
    expect(await sent(0)).toBeUndefined();
    expect(await sent(-50)).toBeUndefined();
    expect(await sent(1)).toBe(1);
    expect(await sent(1_000)).toBe(1);
    expect(await sent(1_001)).toBe(2);
    expect(await sent(1_500)).toBe(2);
    expect(await sent(900_000)).toBe(900);
  });

  test('a delay over 900 s is refused before anything is sent, never clamped', async () => {
    const { transport, calls } = stubbed((entries) => ({
      Successful: entries.map((entry) => ({ Id: entry.Id })),
    }));
    expect(transport.capabilities.maxDeliverDelayMs).toBe(900_000);
    expect(await transport.ring(ring(3, 900_001))).toEqual(
      bells(3).map(() => ({ ok: false, reason: 'delay-too-long' }))
    );
    expect(calls).toHaveLength(0);
  });

  test('a batch of mixed items rings what it can and says which did not', async () => {
    const { transport, calls } = stubbed((entries) => ({
      Successful: entries.map((entry) => ({ Id: entry.Id })),
    }));
    const [a, b, c, d] = bells(4);
    const results = await transport.ring([
      { bell: a! },
      { bell: b!, deliverAfterMs: 901_000 },
      { bell: { ...c!, namespace: 'another-environment' } },
      { bell: d!, deliverAfterMs: Number.NaN },
    ]);
    expect(results).toEqual([
      { ok: true },
      { ok: false, reason: 'delay-too-long' },
      { ok: false, reason: 'rejected' },
      { ok: false, reason: 'rejected' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.entries).toHaveLength(1);
  });

  test('bells for two queues go to two SQS queues, each in its own call', async () => {
    const { transport, calls } = stubbed((entries) => ({
      Successful: entries.map((entry) => ({ Id: entry.Id })),
    }));
    await transport.ring([...ring(3), ...bells(2, 'other').map((bell) => ({ bell }))]);
    const urls = calls.map((call) => call.queueUrl).sort();
    expect(urls).toEqual([
      `http://stub/${queueNames('stub', 'other').queue}`,
      `http://stub/${queueNames('stub', 'q').queue}`,
    ]);
    expect(calls.map((call) => call.entries.length).sort()).toEqual([2, 3]);
  });

  test('a body over 256 KiB is rejected, and a large batch is split by size, not only by count', async () => {
    const { transport, calls } = stubbed((entries) => ({
      Successful: entries.map((entry) => ({ Id: entry.Id })),
    }));
    const big = (jobId: string) => ({ bell: { namespace: 'stub', queue: 'q', jobId } });
    const huge = await transport.ring([big('x'.repeat(262_144))]);
    expect(huge).toEqual([{ ok: false, reason: 'rejected' }]);
    expect(calls).toHaveLength(0);

    const results = await transport.ring(
      Array.from({ length: 10 }, (_, n) => big(`${n}`.repeat(40_000)))
    );
    expect(results.every((result) => result.ok)).toBe(true);
    // 10 bells of 40 KB do not fit one 256 KiB request.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.flatMap((call) => call.entries)).toHaveLength(10);
  });

  test('a closed transport rings nothing', async () => {
    const { transport, calls } = stubbed((entries) => ({
      Successful: entries.map((entry) => ({ Id: entry.Id })),
    }));
    await transport.close();
    expect(await transport.ring(ring(2))).toEqual([
      { ok: false, reason: 'unreachable' },
      { ok: false, reason: 'unreachable' },
    ]);
    expect(calls).toHaveLength(0);
  });

  test('an entry named in neither list is not counted as taken', async () => {
    const { transport } = stubbed(() => ({ Successful: [{ Id: '0' }] }), { ringRetryBudgetMs: 0 });
    expect(await transport.ring(ring(2))).toEqual([
      { ok: true },
      { ok: false, reason: 'unreachable' },
    ]);
  });
});

describe('ring retries', () => {
  test('an entry that failed on the server is sent again alone, and is taken', async () => {
    const t = virtual((entries, call) =>
      call === 0
        ? {
            Successful: entries.filter((_, i) => i !== 1).map((entry) => ({ Id: entry.Id })),
            Failed: [{ Id: '1', SenderFault: false, Code: 'ServiceUnavailable' }],
          }
        : { Successful: entries.map((entry) => ({ Id: entry.Id })) }
    );
    expect(await t.run(ring(3))).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(t.calls.map((call) => call.length)).toEqual([3, 1]);
    // The retried entry is bell 1, renumbered 0 within its own call.
    expect(JSON.parse(t.calls[1]![0]!.MessageBody)).toMatchObject({ jobId: '1' });
    expect(t.calls[1]![0]!.Id).toBe('0');
    expect(t.metrics.sendRetries).toBe(1);
    expect(t.sleeps).toHaveLength(1);
  });

  test('a throttled call is retried with growing waits, and gives up inside the budget', async () => {
    const t = virtual(() => {
      throw awsError('ThrottlingException', 429);
    }, 1_000);
    expect(await t.run(ring(2))).toEqual([
      { ok: false, reason: 'unreachable' },
      { ok: false, reason: 'unreachable' },
    ]);
    expect(t.calls.length).toBeGreaterThan(2);
    // 100, 200, 400 ... with the jitter pinned at its top; never past the budget.
    expect(t.sleeps.slice(0, 3)).toEqual([100, 200, 400]);
    expect(t.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(1_000);
    expect(t.errors).toHaveLength(1);
  });

  test('a refusal the caller must fix is not retried', async () => {
    const t = virtual(() => {
      throw awsError('AccessDenied', 403);
    });
    expect(await t.run(ring(1))).toEqual([{ ok: false, reason: 'unreachable' }]);
    expect(t.calls).toHaveLength(1);
    expect(t.sleeps).toHaveLength(0);
  });

  test('one failing chunk does not hold back the chunks that succeed', async () => {
    // The chunks are 10, 10 and 5 bells; the one of five fails.
    const t = virtual((entries) => {
      if (entries.length === 5) throw awsError('InternalError', 500);
      return { Successful: entries.map((entry) => ({ Id: entry.Id })) };
    }, 0);
    const results = await t.run(ring(25));
    expect(results.filter((result) => result.ok)).toHaveLength(20);
    expect(results.slice(20).every((result) => !result.ok)).toBe(true);
  });

  test('every request is counted for the cost arithmetic', async () => {
    const t = virtual((entries) => ({ Successful: entries.map((entry) => ({ Id: entry.Id })) }));
    await t.run(ring(25));
    expect(t.metrics).toMatchObject({ sendCalls: 3, sentBells: 25, queueUrlLookups: 1 });
    expect(billedRequests(t.metrics)).toBe(4);
  });
});
