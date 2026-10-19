import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { verifyWebhookSignature, WEBHOOK_HEADERS } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { createMsgpackCodec } from '../../store-postgres/src/codec';
import { journalRecorder } from '../../store-postgres/src/store/journal';
import { claimOne, resetTables } from '../../store-postgres/test/finishHelpers';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import { addHook, KEY, SECRET } from '../../store-postgres/test/webhookHelpers';
import type { WebhookSenderOptions } from '../src/webhookConfig';
import { resolveWebhookConfig } from '../src/webhookConfig';
import { RecordingTransport, ticker } from './support';

const DEV = { allowHttp: true, allowPrivate: true };

interface Received {
  readonly headers: Headers;
  readonly body: string;
}

/** Real jobs, the real trigger, the real HTTP client and a real receiver on loopback (development mode). */
describeDb('webhooks end to end: a job to a receiver', () => {
  let t: TestStore;
  let transport: RecordingTransport;
  let received: Received[];
  let respond: (call: number) => Response | Promise<Response>;
  let receiver: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    t = await openTestStore({
      webhookKey: KEY,
      random: () => 0.5,
      ringWindowMs: 3_600_000,
      poolSize: 6,
      recorder: journalRecorder({ namespace: 'test', codec: createMsgpackCodec() }),
    });
    receiver = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        received.push({ headers: request.headers, body: await request.text() });
        return respond(received.length);
      },
    });
  });
  afterAll(async () => {
    await receiver.stop(true);
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    await t.fresh.sql`TRUNCATE qcloud_tick_state`;
    transport = new RecordingTransport({ clock: t.clock });
    received = [];
    respond = () => new Response('ok');
  });
  afterEach(() => {
    respond = () => new Response('ok');
  });

  const tick = (overrides: WebhookSenderOptions = {}) =>
    ticker(t.store, transport, { intervalMs: 5_000 }, undefined, {
      config: resolveWebhookConfig(
        { baseDelayMs: 1_000, maxDelayMs: 60_000, ratePerMinute: 100_000, ...overrides },
        DEV
      )!,
      now: () => t.clock.now(),
    });
  const url = (host = '127.0.0.1') => `http://${host}:${receiver.port}/hooks/in?src=qcloud`;

  test('a completed job reaches the receiver, signed, with ids and no job data', async () => {
    await addHook(t, { url: url(), events: ['job.pushed', 'job.completed'], secret: SECRET });
    const job = await claimOne(t, { removeOnComplete: false }, 'q');
    await t.store.complete(job.lease, 'result-that-must-not-leave');
    const report = await tick().run();
    expect(report.ok).toBe(true);
    // pushed and completed are subscribed; pulled is not.
    expect(report.webhooks).toMatchObject({ claimed: 2, delivered: 2 });
    expect(received).toHaveLength(2);

    const completed = received.find((entry) => JSON.parse(entry.body).event === 'job.completed')!;
    expect(completed.headers.get('content-type')).toBe('application/json');
    expect(completed.headers.get(WEBHOOK_HEADERS.attempt)).toBe('1');
    expect(completed.headers.get(WEBHOOK_HEADERS.id)).toBe(JSON.parse(completed.body).id);
    expect(
      await verifyWebhookSignature({
        secret: SECRET,
        timestamp: completed.headers.get(WEBHOOK_HEADERS.timestamp)!,
        body: completed.body,
        signature: completed.headers.get(WEBHOOK_HEADERS.signature)!,
        now: t.clock.now(),
      })
    ).toBe(true);
    expect(JSON.parse(completed.body)).toMatchObject({
      event: 'job.completed',
      queue: 'q',
      jobId: job.id,
    });
    for (const entry of received) {
      expect(entry.body).not.toContain('result-that-must-not-leave');
      expect(entry.body).not.toContain(SECRET);
    }
  });

  test('a body altered in transit or a replayed timestamp fails verification at the receiver', async () => {
    await addHook(t, { url: url(), events: ['job.pushed'], secret: SECRET });
    await claimOne(t, {}, 'q');
    await tick().run();
    const [entry] = received;
    const check = (overrides: { body?: string; now?: number }) =>
      verifyWebhookSignature({
        secret: SECRET,
        timestamp: entry!.headers.get(WEBHOOK_HEADERS.timestamp)!,
        body: overrides.body ?? entry!.body,
        signature: entry!.headers.get(WEBHOOK_HEADERS.signature)!,
        now: overrides.now ?? t.clock.now(),
      });
    expect(await check({})).toBe(true);
    expect(await check({ body: entry!.body.replace('"q"', '"x"') })).toBe(false);
    expect(await check({ now: t.clock.now() + 300_001 })).toBe(false);
  });

  test('a webhook given no secret is signed with the one generated for it', async () => {
    const hook = await addHook(t, { url: url(), events: ['job.pushed'] });
    await claimOne(t, {}, 'q');
    await tick().run();
    const [entry] = received;
    expect(
      await verifyWebhookSignature({
        secret: hook.secret!,
        timestamp: entry!.headers.get(WEBHOOK_HEADERS.timestamp)!,
        body: entry!.body,
        signature: entry!.headers.get(WEBHOOK_HEADERS.signature)!,
        now: t.clock.now(),
      })
    ).toBe(true);
  });

  test('a receiver that fails twice and then answers gets one delivery, retried with the same id', async () => {
    const hook = await addHook(t, { url: url(), events: ['job.pushed'], secret: SECRET });
    await claimOne(t, {}, 'q');
    respond = (call) => new Response('try later', { status: call < 3 ? 503 : 200 });
    const run = tick();
    await run.run();
    t.clock.advance(1_000);
    await run.run();
    t.clock.advance(2_000);
    await run.run();
    expect(received.map((entry) => entry.headers.get(WEBHOOK_HEADERS.attempt))).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(new Set(received.map((entry) => entry.headers.get(WEBHOOK_HEADERS.id))).size).toBe(1);
    const [delivery] = (await t.store.webhooks.deliveries(hook.id))!.items;
    expect(delivery).toMatchObject({ status: 'delivered', attempts: 3 });
    expect(delivery!.history.map((h) => h.statusCode)).toEqual([503, 503, 200]);
    // The receiver's words are not kept.
    expect(JSON.stringify(delivery)).not.toContain('try later');
  });

  test('a receiver that redirects is a failed attempt, and the Location is never requested', async () => {
    const hook = await addHook(t, { url: url(), events: ['job.pushed'] });
    await claimOne(t, {}, 'q');
    let elsewhere = 0;
    const target = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        elsewhere += 1;
        return new Response('metadata');
      },
    });
    try {
      respond = () =>
        new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${target.port}/` },
        });
      await tick().run();
      const [delivery] = (await t.store.webhooks.deliveries(hook.id))!.items;
      expect(delivery).toMatchObject({
        status: 'pending',
        lastStatusCode: 302,
        lastError: 'redirect not followed (302)',
      });
      expect(elsewhere).toBe(0);
    } finally {
      await target.stop(true);
    }
  });

  test('a receiver slower than the timeout fails the attempt in fixed words and the tick goes on', async () => {
    const hook = await addHook(t, { url: url(), events: ['job.pushed'] });
    await claimOne(t, {}, 'q');
    respond = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return new Response('late');
    };
    const started = performance.now();
    const report = await tick({ timeoutMs: 250, leaseMs: 6_000 }).run();
    expect(performance.now() - started).toBeLessThan(1_400);
    expect(report.ok).toBe(true);
    const [delivery] = (await t.store.webhooks.deliveries(hook.id))!.items;
    expect(delivery).toMatchObject({
      status: 'pending',
      lastStatusCode: null,
      lastError: 'receiver did not answer in time',
    });
  });

  test('localhost resolves through the system resolver and falls back across address families', async () => {
    await addHook(t, { url: url('localhost'), events: ['job.pushed'] });
    await claimOne(t, {}, 'q');
    const report = await tick().run();
    expect(report.webhooks.delivered).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]!.headers.get('host')).toBe(`localhost:${receiver.port}`);
  });

  test('under the strict policy the same loopback webhook is never sent', async () => {
    const hook = await addHook(t, { url: url(), events: ['job.pushed'] });
    await claimOne(t, {}, 'q');
    const strict = ticker(t.store, transport, { intervalMs: 5_000 }, undefined, {
      config: resolveWebhookConfig(
        { baseDelayMs: 1_000 },
        { allowHttp: false, allowPrivate: false }
      )!,
      now: () => t.clock.now(),
    });
    await strict.run();
    expect(received).toEqual([]);
    const [delivery] = (await t.store.webhooks.deliveries(hook.id))!.items;
    expect(delivery).toMatchObject({
      status: 'pending',
      lastError: 'destination not allowed (scheme_not_allowed)',
    });
  });
});
