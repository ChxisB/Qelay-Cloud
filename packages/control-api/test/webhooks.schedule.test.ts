import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { CLAIM, hookSource, KEY, outcome, send } from '../../store-postgres/test/webhookHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

const ENDPOINT = { url: 'https://hooks.example.com/in' };
const NIGHTLY = { cron: '0 0 * * *', timezone: 'Europe/London' };

describeDb('webhook routes: send schedule and batch (D15)', () => {
  let f: JobsFixture;
  let api: JobsApi;
  beforeAll(async () => {
    f = await openJobsFixture({ webhookKey: KEY });
  });
  afterAll(() => f.drop());
  beforeEach(async () => {
    await f.reset();
    api = f.api();
  });

  const create = async (body: Record<string, unknown> = {}) =>
    api.call('POST', '/webhooks', { ...ENDPOINT, source: await hookSource(f), ...body });
  const refused = (answer: Awaited<ReturnType<typeof create>>, option: string) => {
    expect(answer.status, JSON.stringify(answer.body)).toBe(400);
    expect(answer.body.error.code).toBe('unsupported_option');
    expect(JSON.stringify(answer.body.error)).toContain(option);
  };

  test('a create takes a schedule and a batch, fills their defaults, and a read returns them', async () => {
    const made = await create({ schedule: NIGHTLY, batch: { maxEvents: 50 } });
    expect(made.status).toBe(201);
    const expected = { schedule: NIGHTLY, batch: { maxEvents: 50, maxBytes: 262_144 } };
    expect(made.body.data.webhook).toMatchObject(expected);
    const read = await api.call('GET', `/webhooks/${made.body.data.webhook.id}`);
    expect(read.body.data.webhook).toMatchObject(expected);
    expect((await api.call('GET', '/webhooks')).body.data.webhooks[0]).toMatchObject(expected);

    // Midnight in London after the fixture's clock (START is 08:00 on 15 January 2027, which is GMT).
    expect(made.body.data.webhook.nextSendAt).toBe(Date.UTC(2027, 0, 16, 0, 0));
    expect(read.body.data.webhook.nextSendAt).toBe(Date.UTC(2027, 0, 16, 0, 0));

    const zoneless = await create({ schedule: { cron: '@daily' } });
    expect(zoneless.body.data.webhook.schedule).toEqual({ cron: '@daily', timezone: 'UTC' });
    const plain = await create();
    expect(plain.body.data.webhook).toMatchObject({
      schedule: null,
      nextSendAt: null,
      batch: null,
    });
  });

  test('a create refuses a schedule or batch that is not valid, by name, and saves nothing', async () => {
    refused(await create({ schedule: { cron: 'not a cron' } }), 'schedule');
    refused(await create({ schedule: { cron: '0 0 31 2 *' } }), 'schedule');
    refused(
      await create({ schedule: { cron: '0 0 * * *', timezone: 'Mars/Olympus' } }),
      'schedule'
    );
    refused(await create({ schedule: { cron: '0 0 * * *', extra: 1 } }), 'schedule');
    refused(await create({ batch: { maxEvents: 501 } }), 'batch');
    refused(await create({ batch: { maxBytes: 10 } }), 'batch');
    refused(
      await create({
        ...{ url: undefined, destination: 'queue', target: 'jobs' },
        batch: { maxEvents: 5 },
      }),
      'batch'
    );
    expect((await api.call('GET', '/webhooks')).body.data.webhooks).toEqual([]);
  });

  test('a queue route can be scheduled', async () => {
    const made = await create({
      url: undefined,
      destination: 'queue',
      target: 'nightly-jobs',
      schedule: NIGHTLY,
    });
    expect(made.status).toBe(201);
    expect(made.body.data.webhook).toMatchObject({ destination: 'queue', schedule: NIGHTLY });
  });

  test('PATCH sets, changes and clears them with null, and leaves them alone when absent', async () => {
    const id = (await create()).body.data.webhook.id;
    const set = await api.call('PATCH', `/webhooks/${id}`, {
      schedule: NIGHTLY,
      batch: { maxEvents: 20, maxBytes: 4_096 },
    });
    expect(set.status).toBe(200);
    expect(set.body.data.webhook).toMatchObject({
      schedule: NIGHTLY,
      batch: { maxEvents: 20, maxBytes: 4_096 },
    });

    const renamed = await api.call('PATCH', `/webhooks/${id}`, { name: 'Nightly' });
    expect(renamed.body.data.webhook).toMatchObject({ schedule: NIGHTLY, name: 'Nightly' });

    const cleared = await api.call('PATCH', `/webhooks/${id}`, { schedule: null });
    expect(cleared.body.data.webhook).toMatchObject({
      schedule: null,
      batch: { maxEvents: 20, maxBytes: 4_096 },
    });
    const both = await api.call('PATCH', `/webhooks/${id}`, { batch: null });
    expect(both.body.data.webhook).toMatchObject({ schedule: null, batch: null });

    const bad = await api.call('PATCH', `/webhooks/${id}`, { schedule: { cron: 'nope' } });
    refused(bad, 'schedule');
    const batchOnQueue = await create({ url: undefined, destination: 'queue', target: 'jobs' });
    refused(
      await api.call('PATCH', `/webhooks/${batchOnQueue.body.data.webhook.id}`, {
        batch: { maxEvents: 5, maxBytes: 4_096 },
      }),
      'batch'
    );
  });

  test('a delivery shows the batch it went out in, and null when it was sent alone', async () => {
    const id = (await create()).body.data.webhook.id;
    await send(f.t);
    await send(f.t, { n: 2 });
    const [first, second] = await f.store.webhooks.claimDue(CLAIM);
    await f.store.webhooks.record(
      [{ ...outcome(first!, { ok: true }), batchId: 'batch-1' }, outcome(second!, { ok: true })],
      { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 }
    );

    const page = await api.call('GET', `/webhooks/${id}/deliveries`);
    const byId = new Map(page.body.data.deliveries.map((d: { id: string }) => [d.id, d]));
    expect(byId.get(first!.deliveryId)).toMatchObject({ batchId: 'batch-1' });
    expect(byId.get(first!.deliveryId)).toMatchObject({
      history: [expect.objectContaining({ batchId: 'batch-1' })],
    });
    expect(byId.get(second!.deliveryId)).toMatchObject({ batchId: null });
    const all = await api.call('GET', '/webhooks/deliveries');
    expect(
      all.body.data.deliveries.map((d: { batchId: string | null }) => d.batchId).sort()
    ).toEqual(['batch-1', null]);
  });
});
