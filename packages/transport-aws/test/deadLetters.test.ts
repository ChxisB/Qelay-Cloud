import { expect, setDefaultTimeout, test } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { Bell } from '@qelay-cloud/core';
import { TransportError } from '@qelay-cloud/core';
import { MAX_PEEK } from '../src';
import {
  deadLetterCount,
  describeSqs,
  openEnvironment,
  transportFor,
  withTransport,
} from './support';

setDefaultTimeout(30_000);

const bell = (namespace: string, queue: string, jobId: string): Bell => ({
  namespace,
  queue,
  jobId,
});

describeSqs('dead-letter peek on the SQS emulator', () => {
  test('an empty dead-letter queue peeks as an empty list, not as an error', async () => {
    await withTransport(async ({ transport }) => {
      expect(await transport.peekDeadLetters('q', 10)).toEqual([]);
    });
  });

  test('lists what dead-lettered, as bells where the body is one, and leaves it there', async () => {
    await withTransport(async ({ env, transport }) => {
      const dead = env.provisioned('q').deadLetterUrl;
      await env.client.send(
        new SendMessageCommand({
          QueueUrl: dead,
          MessageBody: JSON.stringify(bell(env.namespace, 'q', 'job-1')),
        })
      );
      await env.client.send(new SendMessageCommand({ QueueUrl: dead, MessageBody: 'garbage {' }));
      await env.client.send(
        new SendMessageCommand({
          QueueUrl: dead,
          MessageBody: JSON.stringify(bell(env.namespace, 'another', 'job-2')),
        })
      );

      const peeked = await transport.peekDeadLetters('q', 10);
      expect(peeked).toHaveLength(3);
      expect(peeked.map((letter) => letter.bell?.jobId ?? null).sort()).toEqual([
        'job-1',
        null,
        null,
      ]);
      for (const letter of peeked) {
        // SQS does not say how often a dead letter was delivered, nor when it was moved.
        expect(letter.deliveryCount).toBeNull();
        expect(letter.deadLetteredAt).toBeNull();
      }
      // Peeking again shows the same: nothing was consumed.
      expect(await transport.peekDeadLetters('q', 10)).toHaveLength(3);
      expect((await transport.stats('q')).deadLetterDepth).toBe(3);
    });
  });

  test('stops at the limit, and refuses to read more than a page', async () => {
    await withTransport(async ({ env, transport }) => {
      const dead = env.provisioned('q').deadLetterUrl;
      for (let n = 0; n < 12; n++) {
        await env.client.send(
          new SendMessageCommand({
            QueueUrl: dead,
            MessageBody: JSON.stringify(bell(env.namespace, 'q', `j${n}`)),
          })
        );
      }
      expect(await transport.peekDeadLetters('q', 3)).toHaveLength(3);
      expect(await transport.peekDeadLetters('q', 0)).toEqual([]);
      expect(await transport.peekDeadLetters('q', -5)).toEqual([]);
      const all = await transport.peekDeadLetters('q', MAX_PEEK * 10);
      expect(all.length).toBeLessThanOrEqual(MAX_PEEK);
      expect(all.length).toBeGreaterThanOrEqual(10);
    });
  });

  test('each queue has its own dead letters, and another environment cannot see them', async () => {
    await withTransport(
      async ({ env, transport }) => {
        await env.client.send(
          new SendMessageCommand({
            QueueUrl: env.provisioned('a').deadLetterUrl,
            MessageBody: JSON.stringify(bell(env.namespace, 'a', 'only-a')),
          })
        );
        expect((await transport.peekDeadLetters('a', 10)).map((l) => l.bell?.jobId)).toEqual([
          'only-a',
        ]);
        expect(await transport.peekDeadLetters('b', 10)).toEqual([]);

        const other = await openEnvironment({ queues: ['a'] });
        const foreign = transportFor(other.namespace);
        try {
          expect(await foreign.peekDeadLetters('a', 10)).toEqual([]);
        } finally {
          await foreign.close();
          await other.destroy();
        }
      },
      { queues: ['a', 'b'] }
    );
  });

  test('a queue that does not exist throws, so the caller can say "unknown"', async () => {
    await withTransport(async ({ transport, errors }) => {
      await expect(transport.peekDeadLetters('nothing-here', 10)).rejects.toThrow();
      expect(errors.some((line) => line.startsWith('peek: '))).toBe(true);
    });
  });

  test('a closed transport throws a TransportError', async () => {
    await withTransport(async ({ transport }) => {
      await transport.close();
      await expect(transport.peekDeadLetters('q', 1)).rejects.toThrow(TransportError);
    });
  });

  test('a bell that exhausts its receives lands in the dead-letter queue and in stats', async () => {
    await withTransport(
      async ({ env, transport }) => {
        await transport.ring([{ bell: bell(env.namespace, 'q', 'poison') }]);
        let deliveries = 0;
        const sub = transport.subscribe(
          'q',
          async (delivery) => {
            deliveries += 1;
            await delivery.nack(0);
          },
          { capacity: () => 1 }
        );
        const until = Date.now() + 20_000;
        while ((await deadLetterCount(env, 'q')) < 1) {
          if (Date.now() > until) throw new Error('the bell never dead-lettered');
          await Bun.sleep(100);
        }
        await sub.close();
        expect(deliveries).toBe(3);
        const peeked = await transport.peekDeadLetters('q', 10);
        expect(peeked.map((letter) => letter.bell?.jobId)).toEqual(['poison']);
        const stats = await transport.stats('q');
        expect(stats.deadLetterDepth).toBe(1);
        expect(stats.depth).toBe(0);
      },
      { queue: { maxReceiveCount: 3 } }
    );
  });
});
