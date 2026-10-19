import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { KEY, SECRET } from '../../store-postgres/test/webhookHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

const ENDPOINT = {
  url: 'https://hooks.example.com/in',
  events: ['job.completed', 'job.failed'],
  secret: SECRET,
};
const PREVIEW = { event: { event: 'job.failed', queue: 'emails', jobId: 'j-1', error: 'boom' } };

describeDb('webhook filters, shapes and preview', () => {
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

  const create = (body: Record<string, unknown> = ENDPOINT) => api.call('POST', '/webhooks', body);

  describe('filter and shape', () => {
    const SHAPED = {
      ...ENDPOINT,
      filter: { queue: { $startsWith: 'em' }, error: { $exist: true } },
      shape: { text: { $: 'error' }, where: { $: 'queue' } },
    };

    test('need the delivery writer on: without it, 400 for "writer" and nothing is saved', async () => {
      const answer = await create(SHAPED);
      expect(answer.status).toBe(400);
      expect(answer.body.error.code).toBe('unsupported_option');
      expect(JSON.stringify(answer.body.error)).toContain('writer');
      expect((await api.call('GET', '/webhooks')).body.data.stats.total).toBe(0);
    });

    test('with the writer on they are saved and read back as the objects they were', async () => {
      await f.store.webhooks.startWriter();
      const answer = await create(SHAPED);
      expect(answer.status).toBe(201);
      expect(answer.body.data.webhook).toMatchObject({
        filter: SHAPED.filter,
        shape: SHAPED.shape,
      });
      const plain = (await create(ENDPOINT)).body.data.webhook;
      expect(plain).toMatchObject({ filter: null, shape: null });
    });

    test('a filter or shape outside the grammar is refused by name with the first fault', async () => {
      await f.store.webhooks.startWriter();
      for (const [option, bad] of [
        ['filter', { filter: { jobData: 1 } }],
        ['filter', { filter: { progress: { $gt: 'x' } } }],
        ['shape', { shape: { a: { $: 'data' } } }],
        ['shape', { shape: {} }],
      ] as const) {
        const answer = await create({ ...ENDPOINT, ...bad });
        expect(answer.status, JSON.stringify(bad)).toBe(400);
        expect(answer.body.error.code).toBe('unsupported_option');
        expect(JSON.stringify(answer.body.error)).toContain(option);
      }
    });
  });

  describe('preview', () => {
    const preview = (body: Record<string, unknown>) => api.call('POST', '/webhooks/preview', body);

    test('answers whether the filter lets the event through and the body a shape makes', async () => {
      const shape = { text: { $: 'error' }, at: { $: 'queue' } };
      const hit = await preview({ ...PREVIEW, filter: { state: { $exist: false } }, shape });
      expect(hit.status).toBe(200);
      expect(hit.body.data.preview).toEqual({
        matches: true,
        body: JSON.stringify({ at: 'emails', text: 'boom' }),
        error: null,
      });
      const miss = await preview({ ...PREVIEW, filter: { queue: 'billing' } });
      expect(miss.body.data.preview).toEqual({ matches: false, body: null, error: null });
    });

    test('without a shape it shows the default body; a bad filter or shape is 400 by name', async () => {
      const plain = await preview(PREVIEW);
      expect(JSON.parse(plain.body.data.preview.body)).toMatchObject({
        event: 'job.failed',
        queue: 'emails',
        jobId: 'j-1',
        error: 'boom',
      });
      const bad = await preview({ ...PREVIEW, filter: { nope: 1 } });
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body.error)).toContain('filter');
      expect((await preview({ ...PREVIEW, shape: { x: { $: 'data' } } })).status).toBe(400);
      expect((await preview({ filter: { queue: 'a' } })).status).toBe(400);
    });

    test('saves and sends nothing', async () => {
      await preview({ ...PREVIEW, shape: { x: 1 } });
      const [{ n }] = await f.t.fresh.sql`SELECT count(*)::int AS n FROM qcloud_deliveries`;
      expect(n).toBe(0);
      expect((await api.call('GET', '/webhooks')).body.data.stats.total).toBe(0);
    });
  });
});
