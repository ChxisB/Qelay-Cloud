import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { WEBHOOK_HOLD_REASON } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { event, journal, KEY } from '../../store-postgres/test/webhookHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

const ENDPOINT = {
  url: 'https://hooks.example.com/in?token=private-path-token',
  events: ['job.failed'],
};

describeDb('webhook routes: edit a connection and pause it with hold or ignore', () => {
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
    (await api.call('POST', '/webhooks', { ...ENDPOINT, ...body })).body.data.webhook;

  test('a create takes a name and a description, and a read carries them with the rules', async () => {
    await f.store.webhooks.startWriter();
    const made = await create({
      name: 'Failed orders',
      description: 'to billing',
      delayMs: 5_000,
      dedupe: { windowMs: 60_000, fields: ['queue', 'error'] },
    });
    expect(made).toMatchObject({
      name: 'Failed orders',
      description: 'to billing',
      delayMs: 5_000,
      dedupe: { windowMs: 60_000, fields: ['queue', 'error'] },
      pausedBy: null,
    });
    const plain = await create();
    expect(plain).toMatchObject({ name: null, description: null, delayMs: null, dedupe: null });
  });

  test('PATCH changes only the fields it names, and null clears one', async () => {
    const hook = await create({ name: 'First', description: 'Kept' });
    const named = await api.call('PATCH', `/webhooks/${hook.id}`, { name: 'Second' });
    expect(named.status).toBe(200);
    expect(named.body.data.webhook).toMatchObject({
      name: 'Second',
      description: 'Kept',
      events: ['job.failed'],
      url: ENDPOINT.url,
    });
    const more = await api.call('PATCH', `/webhooks/${hook.id}`, {
      description: null,
      events: ['job.completed', 'job.failed'],
    });
    expect(more.body.data.webhook).toMatchObject({
      name: 'Second',
      description: null,
      events: ['job.completed', 'job.failed'],
    });
    expect((await api.call('GET', `/webhooks/${hook.id}`)).body.data.webhook).toEqual(
      more.body.data.webhook
    );
  });

  test('PATCH refuses what the store refuses, by name, and writes nothing', async () => {
    const hook = await create({ name: 'Keep' });
    const refused = async (body: Record<string, unknown>, option: string) => {
      const answer = await api.call('PATCH', `/webhooks/${hook.id}`, body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.body.error.code).toBe('unsupported_option');
      expect(JSON.stringify(answer.body.error)).toContain(option);
    };
    await refused({}, 'patch');
    await refused({ name: 'a\u0001b' }, 'name');
    await refused({ delayMs: 5_000 }, 'writer');
    await refused({ dedupe: { windowMs: 5, fields: [] } }, 'dedupe');
    await refused({ filter: { queue: 'a' } }, 'writer');
    expect((await api.call('GET', `/webhooks/${hook.id}`)).body.data.webhook.name).toBe('Keep');
  });

  test('PATCH is strict: an unknown key, the url, the secret and an empty event list are 400', async () => {
    const hook = await create();
    for (const body of [
      { url: 'https://other.example.com/' },
      { secret: 'x'.repeat(20) },
      { queue: 'q' },
      { enabled: false },
      { events: [] },
      { events: ['job.nope'] },
      { name: 5 },
    ]) {
      const answer = await api.call('PATCH', `/webhooks/${hook.id}`, body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
    }
    expect((await api.call('PATCH', '/webhooks/nope', { name: 'x' })).status).toBe(404);
  });

  test('PATCH is for an operator, and its audit row has the id and no value', async () => {
    const hook = await create();
    expect((await api.asViewer('PATCH', `/webhooks/${hook.id}`, { name: 'x' })).status).toBe(403);
    expect((await api.call('GET', `/webhooks/${hook.id}`)).body.data.webhook.name).toBeNull();
    await api.call('PATCH', `/webhooks/${hook.id}`, { name: 'secret-looking-name' });
    const rows = [...(await f.store.audit.list({ limit: 100 })).items].reverse();
    const patch = rows.filter((row) => row.action === 'PATCH /webhooks/:id');
    expect(patch.map((row) => [row.status, row.target])).toEqual([
      [403, `id=${hook.id}`],
      [200, `id=${hook.id}`],
    ]);
    expect(JSON.stringify(rows)).not.toContain('secret-looking-name');
    expect(JSON.stringify(rows)).not.toContain('private-path-token');
  });

  test('a viewer still reads only the origin of the address, with the new fields', async () => {
    const hook = await create({ name: 'Visible' });
    const seen = (await api.asViewer('GET', `/webhooks/${hook.id}`)).body.data.webhook;
    expect(seen).toMatchObject({
      url: 'https://hooks.example.com/',
      urlRedacted: true,
      name: 'Visible',
    });
  });

  test('pause with hold: off, still collecting, pausedBy operator; resume sends what was held', async () => {
    const hook = await create({ events: ['job.pushed'] });
    const held = await api.call('PUT', `/webhooks/${hook.id}/enabled`, {
      enabled: false,
      mode: 'hold',
    });
    expect(held.body.data.webhook).toMatchObject({
      enabled: false,
      disabledReason: WEBHOOK_HOLD_REASON,
      pausedBy: 'operator',
    });
    await journal(f.t, [event('pushed', 'q', 'j1')]);
    const [{ n }] = await f.t.fresh.sql`SELECT count(*)::int AS n FROM qcloud_deliveries`;
    expect(n).toBe(1);
    const resumed = await api.call('PUT', `/webhooks/${hook.id}/enabled`, { enabled: true });
    expect(resumed.body.data.webhook).toMatchObject({ enabled: true, pausedBy: null });
  });

  test('pause without a mode, or with ignore, collects nothing; an unknown mode is 400', async () => {
    const hook = await create({ events: ['job.pushed'] });
    const off = await api.call('PUT', `/webhooks/${hook.id}/enabled`, { enabled: false });
    expect(off.body.data.webhook).toMatchObject({ enabled: false, pausedBy: null });
    await journal(f.t, [event('pushed', 'q', 'j1')]);
    const [{ n }] = await f.t.fresh.sql`SELECT count(*)::int AS n FROM qcloud_deliveries`;
    expect(n).toBe(0);
    const ignore = await api.call('PUT', `/webhooks/${hook.id}/enabled`, {
      enabled: false,
      mode: 'ignore',
    });
    expect(ignore.status).toBe(200);
    const bad = await api.call('PUT', `/webhooks/${hook.id}/enabled`, {
      enabled: false,
      mode: 'freeze',
    });
    expect(bad.status).toBe(400);
  });

  test('a route paused for failing reads pausedBy failures', async () => {
    const hook = await create();
    await f.t.fresh.sql`
      UPDATE qcloud_webhooks SET enabled = FALSE, disabled_reason = '5 failed deliveries in a row',
             disabled_at = 1 WHERE id = ${hook.id}`;
    const read = (await api.call('GET', `/webhooks/${hook.id}`)).body.data.webhook;
    expect(read).toMatchObject({ enabled: false, pausedBy: 'failures' });
  });
});
