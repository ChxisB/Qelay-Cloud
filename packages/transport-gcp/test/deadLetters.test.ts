import { afterEach, describe, expect, test } from 'bun:test';
import { PubSub } from '@google-cloud/pubsub';
import { canPeekDeadLetters } from '@qelay-cloud/core';
import type { DeadLetterSource, PulledMessage, SubscriberStub } from '../src';
import {
  DELIVERY_COUNT_ATTRIBUTE,
  encodeBell,
  GRPC_ONLY,
  peekDeadLetters,
  PubSubTransport,
  queueNames,
} from '../src';
import { subscriberSource } from '../src/deadLetters';

const NAMESPACE = 'prod';
const BELL = { namespace: NAMESPACE, queue: 'emails', jobId: 'job-1' };

const body = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value), 'utf8');

function message(overrides: Partial<PulledMessage> = {}): PulledMessage {
  return {
    ackId: 'ack-1',
    data: encodeBell(BELL).data,
    attributes: { [DELIVERY_COUNT_ATTRIBUTE]: '5' },
    publishTime: 1_800_000_000_000,
    ...overrides,
  };
}

function stubSource(messages: PulledMessage[]) {
  const calls = { pulled: [] as Array<[string, number]>, released: [] as string[][] };
  const source: DeadLetterSource = {
    pull: async (subscription, max) => {
      calls.pulled.push([subscription, max]);
      return messages;
    },
    release: async (_subscription, ackIds) => {
      calls.released.push([...ackIds]);
    },
  };
  return { source, calls };
}

describe('peekDeadLetters', () => {
  const route = { namespace: NAMESPACE, queue: 'emails' };

  test('reads the bell, the delivery count and the time of each dead letter', async () => {
    const { source } = stubSource([message()]);
    expect(await peekDeadLetters(source, 'projects/p/subscriptions/s', route, 10)).toEqual([
      { bell: BELL, deliveryCount: 5, deadLetteredAt: 1_800_000_000_000 },
    ]);
  });

  test('gives every pulled message back at once and acknowledges none', async () => {
    const { source, calls } = stubSource([message({ ackId: 'a' }), message({ ackId: 'b' })]);
    await peekDeadLetters(source, 'projects/p/subscriptions/s', route, 10);
    expect(calls.released).toEqual([['a', 'b']]);
  });

  test('a body that is not a bell comes back as null and is still given back', async () => {
    const { source, calls } = stubSource([message({ data: body({ hello: 'world' }) })]);
    const [letter] = await peekDeadLetters(source, 's', route, 10);
    expect(letter).toEqual({ bell: null, deliveryCount: 5, deadLetteredAt: 1_800_000_000_000 });
    expect(calls.released).toHaveLength(1);
  });

  test('a bell of another queue is not a bell', async () => {
    const other = encodeBell({ ...BELL, queue: 'other' }).data;
    const { source } = stubSource([message({ data: other })]);
    expect((await peekDeadLetters(source, 's', route, 10))[0]?.bell).toBeNull();
  });

  test.each([['0'], ['-1'], ['x'], ['']])('a delivery count of %p is unknown', async (value) => {
    const { source } = stubSource([message({ attributes: { [DELIVERY_COUNT_ATTRIBUTE]: value } })]);
    expect((await peekDeadLetters(source, 's', route, 10))[0]?.deliveryCount).toBeNull();
  });

  test('a missing delivery count is unknown', async () => {
    const { source } = stubSource([message({ attributes: {} })]);
    expect((await peekDeadLetters(source, 's', route, 10))[0]?.deliveryCount).toBeNull();
  });

  test('asks for no more than the limit and never more than the cap', async () => {
    const { source, calls } = stubSource([]);
    await peekDeadLetters(source, 's', route, 25);
    await peekDeadLetters(source, 's', route, 5_000);
    expect(calls.pulled.map(([, max]) => max)).toEqual([25, 100]);
  });

  test('a limit of zero pulls nothing', async () => {
    const { source, calls } = stubSource([message()]);
    expect(await peekDeadLetters(source, 's', route, 0)).toEqual([]);
    expect(calls.pulled).toEqual([]);
  });

  test('a release that fails does not fail the peek', async () => {
    const source: DeadLetterSource = {
      pull: async () => [message()],
      release: async () => {
        throw new Error('unavailable');
      },
    };
    expect(await peekDeadLetters(source, 's', route, 10)).toHaveLength(1);
  });
});

describe('subscriberSource', () => {
  test('pulls without returning immediately and maps the received messages', async () => {
    const requests: unknown[] = [];
    const client: SubscriberStub = {
      pull: async (request, options) => {
        requests.push([request, options]);
        return [
          {
            receivedMessages: [
              {
                ackId: 'ack',
                message: {
                  data: body(BELL),
                  attributes: { [DELIVERY_COUNT_ATTRIBUTE]: '7' },
                  publishTime: { seconds: '1800000000', nanos: 250_000_000 },
                },
              },
              { ackId: null, message: null },
            ],
          },
        ];
      },
      modifyAckDeadline: async () => ({}),
    };
    const messages = await subscriberSource(client, 1_500).pull('projects/p/subscriptions/s', 3);
    expect(requests).toEqual([
      [{ subscription: 'projects/p/subscriptions/s', maxMessages: 3 }, { timeout: 1_500 }],
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      ackId: 'ack',
      attributes: { [DELIVERY_COUNT_ATTRIBUTE]: '7' },
      publishTime: 1_800_000_000_250,
    });
  });

  test('releases with an ack deadline of zero', async () => {
    const requests: unknown[] = [];
    const client: SubscriberStub = {
      pull: async () => [{}],
      modifyAckDeadline: async (request) => {
        requests.push(request);
        return {};
      },
    };
    await subscriberSource(client, 1_000).release('s', ['a', 'b']);
    expect(requests).toEqual([{ subscription: 's', ackIds: ['a', 'b'], ackDeadlineSeconds: 0 }]);
  });
});

describe('PubSubTransport.peekDeadLetters', () => {
  const open: PubSubTransport[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((transport) => transport.close()));
  });

  function make(source: DeadLetterSource): PubSubTransport {
    const transport = new PubSubTransport({
      namespace: NAMESPACE,
      // Nothing here reaches a broker: the stub source answers the peek.
      client: new PubSub({
        projectId: 'proj-1',
        apiEndpoint: '127.0.0.1:1',
        emulatorMode: true,
        ...GRPC_ONLY,
      }),
      monitoring: false,
      deadLetterSource: source,
    });
    open.push(transport);
    return transport;
  }

  test('is offered to the Control API as an optional capability', () => {
    expect(canPeekDeadLetters(make(stubSource([]).source))).toBe(true);
  });

  test("reads the queue's own dead-letter subscription", async () => {
    const { source, calls } = stubSource([message()]);
    const letters = await make(source).peekDeadLetters('emails', 10);
    expect(letters).toHaveLength(1);
    expect(calls.pulled).toEqual([
      [
        `projects/proj-1/subscriptions/${queueNames(NAMESPACE, 'emails').deadLetterSubscription}`,
        10,
      ],
    ]);
  });

  test('throws when the broker cannot be read, so the caller can say "unknown"', async () => {
    const source: DeadLetterSource = {
      pull: async () => {
        throw new Error('permission denied');
      },
      release: async () => undefined,
    };
    await expect(make(source).peekDeadLetters('emails', 10)).rejects.toThrow('permission denied');
  });
});
