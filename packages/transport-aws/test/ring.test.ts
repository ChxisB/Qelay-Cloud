import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { Bell } from '@qelay-cloud/core';
import { TransportError } from '@qelay-cloud/core';
import { ensureQueue, removeQueue, SqsTransport } from '../src';
import {
  describeSqs,
  EMULATOR_REGION,
  openEnvironment,
  receiveNow,
  sqsEndpoint,
  transportFor,
  waitFor,
  withTransport,
} from './support';

setDefaultTimeout(30_000);

const bell = (namespace: string, queue: string, jobId: string): Bell => ({
  namespace,
  queue,
  jobId,
});

/** Everything receivable from a queue, left in flight so it is counted once. */
async function drain(client: SQSClient, url: string, want: number): Promise<Set<string>> {
  const seen = new Set<string>();
  await waitFor(
    async () => {
      for (const message of await receiveNow(client, url, 10, 60)) {
        seen.add(JSON.parse(message.Body ?? '{}').jobId);
      }
      return seen.size >= want;
    },
    `${want} bells`,
    10_000,
    50
  );
  return seen;
}

describeSqs('ring on the SQS emulator', () => {
  test('rings every bell of a batch larger than one call, each exactly once', async () => {
    await withTransport(async ({ env, transport }) => {
      const items = Array.from({ length: 125 }, (_, n) => ({
        bell: bell(env.namespace, 'q', `job-${n}`),
      }));
      const results = await transport.ring(items);
      expect(results.every((result) => result.ok)).toBe(true);
      const seen = await drain(env.client, env.provisioned('q').queueUrl, 125);
      expect(seen.size).toBe(125);
      // 125 bells: 13 calls of up to 10, not 125 calls. One cost line per tick.
      expect(transport.metrics.sendCalls).toBe(13);
      expect(transport.metrics.queueUrlLookups).toBe(1);
    });
  });

  test('an empty batch is an empty result and no request', async () => {
    await withTransport(async ({ transport }) => {
      expect(await transport.ring([])).toEqual([]);
      expect(transport.metrics.sendCalls).toBe(0);
    });
  });

  test('items that cannot be rung do not stop the others', async () => {
    await withTransport(async ({ env, transport }) => {
      const results = await transport.ring([
        { bell: bell(env.namespace, 'q', 'a') },
        { bell: bell(env.namespace, 'q', 'late'), deliverAfterMs: 900_001 },
        { bell: bell('someone-else', 'q', 'foreign') },
        { bell: bell(env.namespace, 'q', 'b'), deliverAfterMs: 1_000 },
      ]);
      expect(results.map((result) => (result.ok ? 'ok' : result.reason))).toEqual([
        'ok',
        'delay-too-long',
        'rejected',
        'ok',
      ]);
      await waitFor(
        async () => (await transport.stats('q')).depth === 1,
        'one visible and one delayed bell',
        5_000
      );
      expect((await transport.stats('q')).delayed).toBe(1);
    });
  });

  test('a queue that does not exist is unreachable at once, and reported once per ring', async () => {
    await withTransport(
      async ({ env, transport, errors }) => {
        const started = Date.now();
        const results = await transport.ring([
          { bell: bell(env.namespace, 'missing', 'a') },
          { bell: bell(env.namespace, 'missing', 'b') },
        ]);
        expect(results).toEqual([
          { ok: false, reason: 'unreachable' },
          { ok: false, reason: 'unreachable' },
        ]);
        // A missing queue is not transient: it is not worth the retry budget.
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toStartWith('ring: ');
      },
      { transport: { ringRetryBudgetMs: 10_000 } }
    );
  });

  test('a queue appearing after a failed lookup is found by the next ring', async () => {
    const env = await openEnvironment({ queues: [] });
    const transport = transportFor(env.namespace, { onError: () => {} });
    try {
      const first = await transport.ring([{ bell: bell(env.namespace, 'later', 'a') }]);
      expect(first).toEqual([{ ok: false, reason: 'unreachable' }]);
      await ensureQueue(env.client, env.namespace, 'later', {
        visibilityTimeoutSeconds: 3,
        maxReceiveCount: 5,
      });
      const second = await transport.ring([{ bell: bell(env.namespace, 'later', 'a') }]);
      expect(second).toEqual([{ ok: true }]);
    } finally {
      await transport.close();
      await removeQueue(env.client, env.namespace, 'later').catch(() => {});
      await env.destroy();
    }
  });

  test('an unreachable service is retried for the budget and then every bell is unreachable', async () => {
    const transport = new SqsTransport({
      namespace: 'nowhere',
      region: EMULATOR_REGION,
      endpoint: 'http://127.0.0.1:1',
      credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
      ringRetryBudgetMs: 700,
      onError: () => {},
    });
    try {
      const started = Date.now();
      const results = await transport.ring([{ bell: bell('nowhere', 'q', 'a') }]);
      const took = Date.now() - started;
      expect(results).toEqual([{ ok: false, reason: 'unreachable' }]);
      expect(took).toBeGreaterThanOrEqual(300);
      expect(took).toBeLessThan(5_000);
    } finally {
      await transport.close();
    }
  });

  test('a logger that throws never turns a ring into an exception', async () => {
    const transport = new SqsTransport({
      namespace: 'nowhere',
      region: EMULATOR_REGION,
      endpoint: 'http://127.0.0.1:1',
      credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
      ringRetryBudgetMs: 0,
      onError: () => {
        throw new Error('logger down');
      },
    });
    try {
      expect(await transport.ring([{ bell: bell('nowhere', 'q', 'a') }])).toEqual([
        { ok: false, reason: 'unreachable' },
      ]);
    } finally {
      await transport.close();
    }
  });

  test('queue names that look alike stay three queues, and a bell reaches only its own', async () => {
    const names = ['a.b', 'a_2eb', 'a-b'];
    await withTransport(
      async ({ env, transport }) => {
        const results = await transport.ring(
          names.map((queue) => ({ bell: bell(env.namespace, queue, `for-${queue}`) }))
        );
        expect(results.every((result) => result.ok)).toBe(true);
        for (const queue of names) {
          const seen = await drain(env.client, env.provisioned(queue).queueUrl, 1);
          expect([...seen]).toEqual([`for-${queue}`]);
        }
      },
      { queues: names }
    );
  });

  test('a body naming another queue reaches the handler as no bell at all', async () => {
    await withTransport(async ({ env, transport }) => {
      await env.client.send(
        new SendMessageCommand({
          QueueUrl: env.provisioned('q').queueUrl,
          MessageBody: JSON.stringify(bell(env.namespace, 'other', 'x')),
        })
      );
      const delivered: (Bell | null)[] = [];
      const subscription = transport.subscribe(
        'q',
        async (delivery) => {
          delivered.push(delivery.bell);
          await delivery.ack();
        },
        { capacity: () => 10 }
      );
      await waitFor(() => delivered.length === 1, 'the delivery');
      expect(delivered).toEqual([null]);
      await subscription.close();
    });
  });

  test('a closed transport rings nothing and does not touch the service', async () => {
    const transport = transportFor('closed', { onError: () => {} });
    await transport.close();
    expect(await transport.ring([{ bell: bell('closed', 'q', 'a') }])).toEqual([
      { ok: false, reason: 'unreachable' },
    ]);
    expect(transport.metrics.sendCalls).toBe(0);
    // Closing twice is fine.
    await transport.close();
  });
});

describe('configuration (no emulator needed)', () => {
  const base = {
    region: EMULATOR_REGION,
    endpoint: 'http://127.0.0.1:1',
    credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
  };

  test('an empty namespace is a TransportError', () => {
    expect(() => new SqsTransport({ ...base, namespace: '' })).toThrow(TransportError);
  });

  test('a missing region is a TransportError, never a guess', () => {
    expect(() => new SqsTransport({ namespace: 'prod', endpoint: base.endpoint })).toThrow(
      TransportError
    );
  });

  test('subscribing on a closed transport is a TransportError', async () => {
    const transport = new SqsTransport({ ...base, namespace: 'prod' });
    await transport.close();
    expect(() => transport.subscribe('q', async () => {}, { capacity: () => 1 })).toThrow(
      TransportError
    );
  });

  test('capabilities state the SQS limits', () => {
    const transport = new SqsTransport({ ...base, namespace: 'prod' });
    expect(transport.capabilities).toEqual({
      maxDeliverDelayMs: 900_000,
      maxRingBatch: 10,
      attemptCount: 'approximate',
      retryGranularityMs: 1_000,
    });
    expect('ordering' in transport.capabilities).toBe(false);
  });

  test('the test endpoint is loopback', () => {
    expect(new URL(sqsEndpoint()).hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);
  });
});
