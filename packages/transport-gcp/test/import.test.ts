import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { PubSub } from '@google-cloud/pubsub';
import { Queue } from 'qelay-cloud';
import { describeDb } from '../../../test/support/db';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import { PubSubTransport } from '../src';
import { main, queueSink } from '../src/importCli';
import type { AckingStub, ImportMessage, ImportSource } from '../src/importer';
import { importSource, importSubscription, toImportJob } from '../src/importer';
import type { Environment } from './support';
import {
  describePubsub,
  EMULATOR_PROJECT,
  emulatorClient,
  emulatorHost,
  openEnvironment,
  pullNow,
  uniqueNamespace,
} from './support';

const message = (id: string, data: string, attributes: Record<string, string> = {}) =>
  ({ ackId: `ack-${id}`, messageId: id, data, attributes }) satisfies ImportMessage;

/** A source over a list: pages come off the front, acks and releases are written down. */
function listSource(messages: ImportMessage[]) {
  const acked: string[] = [];
  const released: string[] = [];
  const pending = [...messages];
  const source: ImportSource = {
    pull: async (max) => pending.splice(0, max),
    ack: async (ids) => void acked.push(...ids),
    release: async (ids) => void released.push(...ids),
  };
  return { source, acked, released };
}

test('import: the body is JSON when it parses and text when not, the attributes sit beside it, the id is the message id', () => {
  expect(toImportJob(message('1', '{"id":500,"name":"chris"}', { origin: 'web' }), 'm')).toEqual({
    name: 'm',
    data: { origin: 'web', body: { id: 500, name: 'chris' } },
    opts: { jobId: '1' },
  });
  expect(toImportJob(message('2', 'plain text'), 'm').data).toEqual({ body: 'plain text' });
  expect(toImportJob(message('3', 'x', { body: 'lost' }), 'm').data).toEqual({ body: 'x' });
  expect(toImportJob({ ...message('4', ''), data: Buffer.from('{"a":1}') }, 'm').data).toEqual({
    body: { a: 1 },
  });
});

test('import: a page is stored, then acked; the same message twice in a page is stored once', async () => {
  const { source, acked } = listSource([message('1', '1'), message('1', '1'), message('2', '2')]);
  const stored: string[][] = [];
  const report = await importSubscription(
    source,
    async (jobs) => {
      expect(acked).toEqual([]);
      stored.push(jobs.map((job) => job.opts.jobId));
      return { created: jobs.length };
    },
    { jobName: 'm', emptyPulls: 1 }
  );
  expect(stored).toEqual([['1', '2']]);
  expect(acked).toEqual(['ack-1', 'ack-1', 'ack-2']);
  expect(report).toEqual({ pulled: 3, created: 2, acked: 3 });
});

test('import: --max stops at the limit, and a dry run stores and acks nothing and gives every message back', async () => {
  const many = Array.from({ length: 10 }, (_, i) => message(String(i), 'x'));
  const limited = listSource(many);
  const sink = async (jobs: readonly unknown[]) => ({ created: jobs.length });
  const report = await importSubscription(limited.source, sink, {
    jobName: 'm',
    max: 4,
    page: 3,
    emptyPulls: 1,
  });
  expect(report).toEqual({ pulled: 4, created: 4, acked: 4 });

  const dry = listSource(many);
  const never = async () => {
    throw new Error('stored in a dry run');
  };
  const counted = await importSubscription(dry.source, never, {
    jobName: 'm',
    dryRun: true,
    page: 3,
    emptyPulls: 1,
  });
  expect(counted).toEqual({ pulled: 10, created: 0, acked: 0 });
  expect(dry.acked).toEqual([]);
  expect(dry.released).toHaveLength(10);
});

test('import: a page that fails to store is handed back at once and nothing is acked', async () => {
  const { source, acked, released } = listSource([message('1', 'x'), message('2', 'x')]);
  const failing = async () => {
    throw new Error('database down');
  };
  await expect(importSubscription(source, failing, { jobName: 'm' })).rejects.toThrow(
    'database down'
  );
  expect(acked).toEqual([]);
  expect(released).toEqual(['ack-1', 'ack-2']);
});

test('import: a pull that times out on an empty subscription is an empty page', async () => {
  const stub = {
    pull: async () => {
      throw Object.assign(new Error('Deadline exceeded'), { code: 4 });
    },
  } as unknown as AckingStub;
  expect(await importSource(stub, 'projects/p/subscriptions/s', 1).pull(10)).toEqual([]);
  const broken = {
    pull: async () => {
      throw Object.assign(new Error('denied'), { code: 7 });
    },
  } as unknown as AckingStub;
  await expect(importSource(broken, 'projects/p/subscriptions/s', 1).pull(10)).rejects.toThrow(
    'denied'
  );
});

test('import: a real project is refused without QCLOUD_REAL_CLOUD=1, before anything is contacted', async () => {
  const lines: string[] = [];
  const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
  const args = [
    '--subscription',
    'projects/some-real-project/subscriptions/orders',
    '--queue',
    'q',
  ];
  expect(await main(args, { QCLOUD_DATABASE_URL: 'postgres://x' }, io)).toBe(2);
  expect(lines.join('\n')).toContain('QCLOUD_REAL_CLOUD=1');
  lines.length = 0;
  // Allowed to reach Google Cloud, but a leaked emulator variable would hide the pull in an emulator.
  const leaked = { QCLOUD_REAL_CLOUD: '1', PUBSUB_EMULATOR_HOST: '127.0.0.1:1' };
  expect(await main(args, { ...leaked, QCLOUD_DATABASE_URL: 'postgres://x' }, io)).toBe(2);
  expect(lines.join('\n')).toContain('PUBSUB_EMULATOR_HOST');
  expect(await main(['--queue', 'q'], {}, io)).toBe(2);
});

describeDb('import from Pub/Sub', () => {
  describePubsub('Pub/Sub emulator', () => {
    const NAMESPACE = uniqueNamespace();
    let t: TestStore;
    let env: Environment;
    let pubsub: PubSub;
    let transport: PubSubTransport;
    let queue: Queue;
    let sourceId: string;

    beforeAll(async () => {
      t = await openTestStore({ clock: null, namespace: NAMESPACE });
      env = await openEnvironment({ namespace: NAMESPACE, queues: ['q'] });
    });
    afterAll(async () => {
      await env?.destroy();
      await t?.drop();
    });
    beforeEach(async () => {
      pubsub = emulatorClient();
      sourceId = `import-${uniqueNamespace()}`;
      const [topic] = await pubsub.createTopic(sourceId);
      await topic.createSubscription(sourceId, { ackDeadlineSeconds: 10 });
      transport = new PubSubTransport({
        namespace: NAMESPACE,
        projectId: EMULATOR_PROJECT,
        emulatorHost: emulatorHost(),
      });
      queue = new Queue('q', { transport, store: t.store });
    });
    afterEach(async () => {
      await queue?.drain();
      await queue?.close();
      await transport?.close();
      await pubsub.subscription(sourceId).delete();
      await pubsub.topic(sourceId).delete();
      await pubsub.close();
    });

    const publish = (count: number, from = 0) =>
      Promise.all(
        Array.from({ length: count }, (_, i) =>
          pubsub.topic(sourceId).publishMessage({
            data: Buffer.from(JSON.stringify({ n: from + i })),
            attributes: { tenant: 'acme' },
          })
        )
      );
    const open = async () =>
      importSource(
        (await pubsub.getClientAsync_({ client: 'SubscriberClient' })) as unknown as AckingStub,
        `projects/${EMULATOR_PROJECT}/subscriptions/${sourceId}`,
        3_000
      );
    const jobCount = async () => (await queue.getJobCounts()).waiting;

    test('250 messages become 250 jobs, each acked once; a second run adds none', async () => {
      await publish(250);
      const real = await open();
      const acks: string[] = [];
      const counting: ImportSource = {
        ...real,
        ack: async (ids) => {
          acks.push(...ids);
          await real.ack(ids);
        },
      };
      const first = await importSubscription(counting, queueSink(queue), {
        jobName: 'message',
        emptyPulls: 2,
      });
      expect(first).toEqual({ pulled: 250, created: 250, acked: 250 });
      expect(new Set(acks).size).toBe(250);
      expect(acks).toHaveLength(250);
      expect(await jobCount()).toBe(250);
      expect(await pullNow(sourceId)).toHaveLength(0);

      const second = await importSubscription(counting, queueSink(queue), {
        jobName: 'message',
        emptyPulls: 2,
      });
      expect(second).toEqual({ pulled: 0, created: 0, acked: 0 });
      expect(await jobCount()).toBe(250);
    }, 60_000);

    test('a crash between the add and the ack delivers the page again and adds no duplicate', async () => {
      await publish(250);
      const real = await open();
      let first = true;
      const crashing: ImportSource = {
        ...real,
        // A killed process neither acks nor hands the page back: the ack deadline does.
        ack: async (ids) => {
          if (!first) return real.ack(ids);
          first = false;
          throw new Error('killed before the ack');
        },
        release: async () => undefined,
      };
      await expect(
        importSubscription(crashing, queueSink(queue), { jobName: 'message', emptyPulls: 1 })
      ).rejects.toThrow('killed before the ack');
      expect(await jobCount()).toBe(100);

      await Bun.sleep(11_000);
      const again = await importSubscription(real, queueSink(queue), {
        jobName: 'message',
        emptyPulls: 2,
      });
      expect(again).toEqual({ pulled: 250, created: 150, acked: 250 });
      expect(await jobCount()).toBe(250);
      expect(await pullNow(sourceId)).toHaveLength(0);
    }, 60_000);

    test('import from the command line: the job carries the attributes and body, and the queue is rung', async () => {
      await pubsub.topic(sourceId).publishMessage({
        data: Buffer.from('{"id":500,"name":"chris"}'),
        attributes: { tenant: 'acme' },
      });
      await pubsub.topic(sourceId).publishMessage({ data: Buffer.from('hello') });
      const lines: string[] = [];
      const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
      const argv = [
        '--subscription',
        sourceId,
        '--queue',
        'q',
        '--job-name',
        'order',
        '--project',
        EMULATOR_PROJECT,
        '--emulator-host',
        emulatorHost(),
        '--wait',
        '1',
      ];
      expect(await main([...argv, '--dry-run'], { QCLOUD_NAMESPACE: NAMESPACE }, io)).toBe(0);
      expect(JSON.parse(lines.pop()!)).toMatchObject({ dryRun: true, pulled: 2, created: 0 });
      expect(await jobCount()).toBe(0);

      // The dry run gave both back at once, so they are deliverable now.
      const code = await main(argv, { QCLOUD_NAMESPACE: NAMESPACE }, io, { store: t.store });
      expect(lines).toHaveLength(1);
      expect(code).toBe(0);
      expect(JSON.parse(lines[0]!)).toMatchObject({ queue: 'q', pulled: 2, created: 2, acked: 2 });
      const jobs = await queue.getJobs({ state: 'waiting' });
      expect(jobs).toHaveLength(2);
      expect(jobs.map((job) => [job.name, job.data])).toEqual(
        expect.arrayContaining([
          ['order', { body: 'hello' }],
          ['order', { tenant: 'acme', body: { id: 500, name: 'chris' } }],
        ])
      );
      expect((await pullNow(env.names('q').subscription)).length).toBeGreaterThan(0);
    }, 60_000);
  });
});
