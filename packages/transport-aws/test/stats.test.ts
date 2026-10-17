import { describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  ATTRIBUTES_LAG_MS,
  AgeReader,
  CLOUDWATCH_LAG_MS,
  queueNames,
  SOURCE_ATTRIBUTES,
  SOURCE_ATTRIBUTES_AND_AGE,
  SqsTransport,
} from '../src';
import { awsError } from './stub';

type Attributes = Record<string, string>;
const NAMES = queueNames('stub', 'q');

interface Fixture {
  readonly transport: SqsTransport;
  readonly errors: { message: string; source: string }[];
  readonly cloudWatchCalls: () => number;
  readonly attributeCalls: () => number;
}

/** A transport on stub SQS and CloudWatch clients. Each stub answers by queue name or throws. */
function fixture(options: {
  attributes: (name: string) => Attributes | Error;
  metrics?: (call: number) => unknown;
  cacheMs?: number;
}): Fixture {
  let cloudWatch = 0;
  let attributeCalls = 0;
  const errors: { message: string; source: string }[] = [];
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, string> }) => {
      if (command.constructor.name === 'GetQueueUrlCommand') {
        return { QueueUrl: `http://stub/${command.input.QueueName}` };
      }
      attributeCalls += 1;
      const answer = options.attributes(command.input.QueueUrl!.replace('http://stub/', ''));
      if (answer instanceof Error) throw answer;
      return { Attributes: answer };
    },
    destroy: () => {},
  } as unknown as SQSClient;
  const monitoring = options.metrics
    ? {
        client: {
          send: async () => {
            cloudWatch += 1;
            const out = options.metrics!(cloudWatch - 1);
            if (out instanceof Error) throw out;
            return out;
          },
        },
        ...(options.cacheMs === undefined ? {} : { cacheMs: options.cacheMs }),
      }
    : (false as const);
  const transport = new SqsTransport({
    namespace: 'stub',
    client,
    monitoring: monitoring as never,
    onError: (error, source) => errors.push({ message: error.message, source }),
  });
  return {
    transport,
    errors,
    cloudWatchCalls: () => cloudWatch,
    attributeCalls: () => attributeCalls,
  };
}

const counts = (visible: number, notVisible: number, delayed: number): Attributes => ({
  ApproximateNumberOfMessages: String(visible),
  ApproximateNumberOfMessagesNotVisible: String(notVisible),
  ApproximateNumberOfMessagesDelayed: String(delayed),
});

const series = (age: number | null, dead: number | null) => ({
  MetricDataResults: [
    { Id: 'age', Values: age === null ? [] : [age] },
    { Id: 'dead', Values: dead === null ? [] : [dead] },
  ],
});

describe('stats', () => {
  test('reports the counts of the queue and the sum of its dead-letter queue, as approximate', async () => {
    const f = fixture({
      attributes: (name) => (name === NAMES.queue ? counts(4, 2, 7) : counts(1, 0, 2)),
    });
    const before = Date.now();
    const stats = await f.transport.stats('q');
    expect(stats).toMatchObject({
      depth: 4,
      inFlight: 2,
      delayed: 7,
      deadLetterDepth: 3,
      oldestAgeMs: null,
      deadLetterOldestAgeMs: null,
      source: SOURCE_ATTRIBUTES,
      maxStalenessMs: ATTRIBUTES_LAG_MS,
    });
    expect(stats.observedAt).toBeGreaterThanOrEqual(before);
    // The counts are approximate by SQS's definition: it never claims to be exact.
    expect(stats.maxStalenessMs).toBeGreaterThan(0);
  });

  test('adds the age of the oldest bell from CloudWatch, in milliseconds', async () => {
    const f = fixture({
      attributes: () => counts(1, 0, 0),
      metrics: () => series(12.4, 90),
    });
    const stats = await f.transport.stats('q');
    expect(stats.oldestAgeMs).toBe(12_400);
    expect(stats.deadLetterOldestAgeMs).toBe(90_000);
    expect(stats.source).toBe(SOURCE_ATTRIBUTES_AND_AGE);
    // A metric is minutes behind: its staleness is the CloudWatch lag plus how long a reading is kept.
    expect(stats.maxStalenessMs).toBe(CLOUDWATCH_LAG_MS + 60_000);
  });

  test('no CloudWatch sample is an unknown age, never zero', async () => {
    const f = fixture({ attributes: () => counts(0, 0, 0), metrics: () => series(null, null) });
    const stats = await f.transport.stats('q');
    expect(stats.depth).toBe(0);
    expect(stats.oldestAgeMs).toBeNull();
    expect(stats.deadLetterOldestAgeMs).toBeNull();
  });

  test('CloudWatch failing leaves the counts, reports once, and is not retried at once', async () => {
    const f = fixture({
      attributes: () => counts(5, 1, 0),
      metrics: () => awsError('AccessDenied', 403),
    });
    const first = await f.transport.stats('q');
    expect(first).toMatchObject({
      depth: 5,
      inFlight: 1,
      oldestAgeMs: null,
      source: SOURCE_ATTRIBUTES,
    });
    expect(first.maxStalenessMs).toBe(ATTRIBUTES_LAG_MS);
    await f.transport.stats('q');
    expect(f.errors.map((error) => error.source)).toEqual(['stats']);
    expect(f.cloudWatchCalls()).toBe(1);
  });

  test('a reading is reused for the cache time and then read again', async () => {
    const f = fixture({
      attributes: () => counts(1, 0, 0),
      metrics: (call) => series(call + 1, null),
      cacheMs: 80,
    });
    expect((await f.transport.stats('q')).oldestAgeMs).toBe(1_000);
    expect((await f.transport.stats('q')).oldestAgeMs).toBe(1_000);
    expect(f.cloudWatchCalls()).toBe(1);
    await Bun.sleep(120);
    expect((await f.transport.stats('q')).oldestAgeMs).toBe(2_000);
  });

  test('a queue SQS cannot read at all answers unavailable, with every count null', async () => {
    const f = fixture({ attributes: () => awsError('QueueDoesNotExist', 400) });
    const stats = await f.transport.stats('q');
    expect(stats).toMatchObject({
      depth: null,
      inFlight: null,
      delayed: null,
      oldestAgeMs: null,
      deadLetterDepth: null,
      source: 'unavailable',
      maxStalenessMs: 0,
    });
    expect(f.errors.map((error) => error.source)).toEqual(['stats']);
  });

  test('an unreadable dead-letter queue nulls only its depth', async () => {
    const f = fixture({
      attributes: (name) =>
        name === NAMES.queue ? counts(3, 0, 1) : awsError('AccessDenied', 403),
    });
    expect(await f.transport.stats('q')).toMatchObject({
      depth: 3,
      delayed: 1,
      deadLetterDepth: null,
    });
  });

  test('a count SQS leaves out is null, and nulls the sum it belongs to', async () => {
    const f = fixture({
      attributes: (name): Record<string, string> =>
        name === NAMES.queue
          ? { ApproximateNumberOfMessages: '5' }
          : { ApproximateNumberOfMessages: '1', ApproximateNumberOfMessagesNotVisible: '1' },
    });
    expect(await f.transport.stats('q')).toMatchObject({
      depth: 5,
      inFlight: null,
      delayed: null,
      deadLetterDepth: null,
    });
  });

  test('a logger that throws does not break stats', async () => {
    const client = {
      send: async () => {
        throw awsError('InternalError', 500);
      },
      destroy: () => {},
    } as unknown as SQSClient;
    const transport = new SqsTransport({
      namespace: 'stub',
      client,
      monitoring: false,
      onError: () => {
        throw new Error('logger down');
      },
    });
    expect((await transport.stats('q')).source).toBe('unavailable');
  });
});

describe('AgeReader', () => {
  const clock = () => {
    let now = 1_000_000;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  };

  test('asks for the queue and its dead-letter queue in one request', async () => {
    const sent: {
      MetricDataQueries: { MetricStat: { Metric: { Dimensions: { Value: string }[] } } }[];
    }[] = [];
    const reader = new AgeReader({
      client: {
        send: async (command: { input: (typeof sent)[number] }) => {
          sent.push(command.input);
          return series(1, 2);
        },
      },
      cacheMs: 1_000,
      timeoutMs: 1_000,
      onError: () => {},
    });
    await reader.read('main', 'main-dlq');
    expect(sent).toHaveLength(1);
    expect(
      sent[0]!.MetricDataQueries.map((query) => query.MetricStat.Metric.Dimensions[0]!.Value)
    ).toEqual(['main', 'main-dlq']);
  });

  test('shares one request between concurrent readers', async () => {
    let calls = 0;
    const reader = new AgeReader({
      client: {
        send: async () => {
          calls += 1;
          await Bun.sleep(20);
          return series(3, null);
        },
      },
      cacheMs: 1_000,
      timeoutMs: 1_000,
      onError: () => {},
    });
    const readings = await Promise.all([reader.read('a', 'a-dlq'), reader.read('a', 'a-dlq')]);
    expect(calls).toBe(1);
    expect(readings[0]).toEqual(readings[1]!);
  });

  test('a failure is remembered for at most ten seconds, whatever the cache time', async () => {
    const time = clock();
    let calls = 0;
    const reader = new AgeReader({
      client: {
        send: async () => {
          calls += 1;
          if (calls === 1) throw awsError('ThrottlingException', 429);
          return series(7, null);
        },
      },
      cacheMs: 600_000,
      timeoutMs: 1_000,
      onError: () => {},
      now: time.now,
    });
    expect((await reader.read('a', 'a-dlq')).available).toBe(false);
    time.advance(9_000);
    expect((await reader.read('a', 'a-dlq')).available).toBe(false);
    expect(calls).toBe(1);
    time.advance(2_000);
    expect(await reader.read('a', 'a-dlq')).toMatchObject({ available: true, oldestAgeMs: 7_000 });
    expect(calls).toBe(2);
  });
});
