import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { hookSource, KEY, SECRET } from '../../store-postgres/test/webhookHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

const URL_ = 'https://hooks.example.com/in';
const REQUEST = {
  method: 'POST',
  headers: { 'x-kind': 'invoice' },
  body: { id: 500, name: 'chris' },
};

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

  const create = async (extra: Record<string, unknown> = {}) =>
    api.call('POST', '/webhooks', {
      url: URL_,
      secret: SECRET,
      source: await hookSource(f),
      ...extra,
    });

  describe('filter and shape', () => {
    const SHAPED = {
      filter: { 'body.name': { $startsWith: 'ch' }, 'headers.x-kind': { $exist: true } },
      shape: { who: { $: 'body.name' }, kind: { $: 'headers.x-kind' } },
    };

    test('are saved and read back as the objects they were', async () => {
      const answer = await create(SHAPED);
      expect(answer.status).toBe(201);
      expect(answer.body.data.webhook).toMatchObject(SHAPED);
      const plain = (await create()).body.data.webhook;
      expect(plain).toMatchObject({ filter: null, shape: null });
    });

    test('a filter or shape outside the grammar is refused by name with the first fault', async () => {
      for (const [option, bad] of [
        ['filter', { filter: { jobData: 1 } }],
        ['filter', { filter: { 'body.n': { $gt: 'x' } } }],
        ['shape', { shape: { a: { $: 'data' } } }],
        ['shape', { shape: {} }],
      ] as const) {
        const answer = await create(bad);
        expect(answer.status, JSON.stringify(bad)).toBe(400);
        expect(answer.body.error.code).toBe('unsupported_option');
        expect(JSON.stringify(answer.body.error)).toContain(option);
      }
    });
  });

  describe('preview', () => {
    const preview = (body: Record<string, unknown>) => api.call('POST', '/webhooks/preview', body);

    test('answers whether the filter lets the request through and the body a shape makes', async () => {
      const shape = { who: { $: 'body.name' }, id: { $: 'body.id' } };
      const hit = await preview({
        request: REQUEST,
        filter: { 'headers.x-kind': 'invoice' },
        shape,
      });
      expect(hit.status).toBe(200);
      expect(hit.body.data.preview).toEqual({
        matches: true,
        body: JSON.stringify({ id: 500, who: 'chris' }),
        error: null,
      });
      const miss = await preview({ request: REQUEST, filter: { 'headers.x-kind': 'refund' } });
      expect(miss.body.data.preview).toEqual({ matches: false, body: null, error: null });
    });

    test('without a shape it shows the body as sent; a bad filter or shape is 400 by name', async () => {
      const plain = await preview({ request: REQUEST });
      expect(JSON.parse(plain.body.data.preview.body)).toEqual({ id: 500, name: 'chris' });
      const bad = await preview({ request: REQUEST, filter: { nope: 1 } });
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body.error)).toContain('filter');
      expect((await preview({ request: REQUEST, shape: { x: { $: 'data' } } })).status).toBe(400);
      expect((await preview({ filter: { method: 'POST' } })).status).toBe(400);
    });

    test('saves and sends nothing', async () => {
      await preview({ request: REQUEST, shape: { x: 1 } });
      const [{ n }] = await f.t.fresh.sql`SELECT count(*)::int AS n FROM qcloud_deliveries`;
      expect(n).toBe(0);
      expect((await api.call('GET', '/webhooks')).body.data.stats.total).toBe(0);
    });
  });
});
