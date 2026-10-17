import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { MAX_WEBHOOKS, openSecret, UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { WebhookDisabledError, WebhookKeyError, WebhookLimitError } from '../src/errors';
import { secretContext } from '../src/store/webhooks';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import { addHook, KEY, SECRET } from './webhookHelpers';

describeDb('webhooks: the registry', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ webhookKey: KEY });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  test('create returns the webhook with its defaults, and list and get agree', async () => {
    const hook = await addHook(t, {
      events: ['job.failed', 'job.failed', 'job.pushed'],
      queue: 'q',
    });
    expect(hook).toMatchObject({
      url: 'https://hooks.example.com/in',
      events: ['job.failed', 'job.pushed'],
      queue: 'q',
      signed: false,
      enabled: true,
      createdBy: 'tester',
      lastTriggered: null,
      successCount: 0,
      failureCount: 0,
    });
    expect(await t.store.webhooks.get(hook.id)).toEqual(hook);
    expect(await t.store.webhooks.list()).toEqual([hook]);
    expect(await t.store.webhooks.get('missing')).toBeNull();
  });

  test('a secret is stored sealed, opens only for its own webhook, and is never read back', async () => {
    const hook = await addHook(t, { secret: SECRET });
    expect(hook.signed).toBe(true);
    expect(JSON.stringify(hook)).not.toContain(SECRET);
    expect(JSON.stringify(await t.store.webhooks.list())).not.toContain(SECRET);
    const [row] = await t.fresh.sql<Array<{ secret_sealed: string }>>`
      SELECT secret_sealed FROM qcloud_webhooks`;
    expect(row!.secret_sealed.startsWith('v1:')).toBe(true);
    expect(row!.secret_sealed).not.toContain(SECRET);
    const key = Uint8Array.from(Buffer.from(KEY, 'hex'));
    expect(await openSecret(row!.secret_sealed, key, secretContext('test', hook.id))).toBe(SECRET);
    expect(await openSecret(row!.secret_sealed, key, secretContext('test', 'another'))).toBeNull();
  });

  test('a secret needs a key, and a store with none refuses it before writing anything', async () => {
    const keyless = t.another({ webhookKey: undefined as never });
    await expect(
      keyless.webhooks.create(
        { url: 'https://hooks.example.com/in', events: ['job.pushed'], secret: SECRET },
        'op'
      )
    ).rejects.toBeInstanceOf(WebhookKeyError);
    expect(await t.store.webhooks.list()).toEqual([]);
    const unsigned = await keyless.webhooks.create(
      { url: 'https://hooks.example.com/in', events: ['job.pushed'] },
      'op'
    );
    expect(unsigned.signed).toBe(false);
  });

  test('a bad key is refused when the store is built', () => {
    expect(() => t.another({ webhookKey: 'short' })).toThrow(UnsupportedOptionError);
  });

  test.each([
    ['an empty url', { url: '' }],
    ['no events', { events: [] }],
    ['an unknown event', { events: ['job.exploded'] }],
    ['a queue with NUL', { queue: 'a\0b' }],
    ['a short secret', { secret: 'short' }],
    ['a long secret', { secret: 'x'.repeat(257) }],
    ['a url over the limit', { url: `https://example.com/${'a'.repeat(2048)}` }],
  ])('%s is refused with UnsupportedOptionError', async (_name, bad) => {
    await expect(addHook(t, bad as never)).rejects.toBeInstanceOf(UnsupportedOptionError);
    expect(await t.store.webhooks.list()).toEqual([]);
  });

  test('a namespace holds at most MAX_WEBHOOKS, even when creations race', async () => {
    await Promise.all(Array.from({ length: MAX_WEBHOOKS - 5 }, () => addHook(t)));
    const racing = await Promise.allSettled(Array.from({ length: 12 }, () => addHook(t)));
    expect(racing.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    const refused = racing.filter((r) => r.status === 'rejected');
    expect(refused).toHaveLength(7);
    expect(refused.every((r) => r.reason instanceof WebhookLimitError)).toBe(true);
    expect(await t.store.webhooks.list()).toHaveLength(MAX_WEBHOOKS);
    // Another namespace has its own allowance.
    await t
      .another({ namespace: 'other' })
      .webhooks.create({ url: 'https://hooks.example.com/in', events: ['job.pushed'] }, 'op');
  });

  test('setEnabled and delete say whether the webhook was there', async () => {
    const hook = await addHook(t);
    expect((await t.store.webhooks.setEnabled(hook.id, false))?.enabled).toBe(false);
    expect((await t.store.webhooks.get(hook.id))?.enabled).toBe(false);
    expect(await t.store.webhooks.setEnabled('missing', true)).toBeNull();
    expect(await t.store.webhooks.delete(hook.id)).toBe(true);
    expect(await t.store.webhooks.delete(hook.id)).toBe(false);
    expect(await t.store.webhooks.get(hook.id)).toBeNull();
  });

  test('deleting a webhook deletes its deliveries', async () => {
    const hook = await addHook(t);
    await t.store.webhooks.sendTest(hook.id);
    await t.store.webhooks.delete(hook.id);
    const [{ n }] = await t.fresh.sql<[{ n: number }]>`
      SELECT count(*)::int AS n FROM qcloud_webhook_deliveries`;
    expect(n).toBe(0);
  });

  test('a test delivery needs an enabled webhook that exists', async () => {
    const hook = await addHook(t);
    expect(await t.store.webhooks.sendTest('missing')).toBeNull();
    await t.store.webhooks.setEnabled(hook.id, false);
    await expect(t.store.webhooks.sendTest(hook.id)).rejects.toBeInstanceOf(WebhookDisabledError);
  });

  test('deliveries page newest first, filter by status, and refuse bad cursors', async () => {
    const hook = await addHook(t);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push((await t.store.webhooks.sendTest(hook.id))!.id);
    const first = await t.store.webhooks.deliveries(hook.id, { limit: 2 });
    expect(first!.items.map((d) => d.id)).toEqual([ids[4]!, ids[3]!]);
    expect(first!.next).toBe(ids[3]!);
    const second = await t.store.webhooks.deliveries(hook.id, { limit: 2, before: first!.next! });
    expect(second!.items.map((d) => d.id)).toEqual([ids[2]!, ids[1]!]);
    const last = await t.store.webhooks.deliveries(hook.id, { limit: 2, before: second!.next! });
    expect(last).toMatchObject({ next: null });
    expect(last!.items.map((d) => d.id)).toEqual([ids[0]!]);
    expect((await t.store.webhooks.deliveries(hook.id, { status: 'failed' }))!.items).toEqual([]);
    expect(await t.store.webhooks.deliveries('missing')).toBeNull();
    await expect(t.store.webhooks.deliveries(hook.id, { before: 'x' })).rejects.toBeInstanceOf(
      UnsupportedOptionError
    );
    await expect(t.store.webhooks.deliveries(hook.id, { limit: 0 })).rejects.toBeInstanceOf(
      UnsupportedOptionError
    );
  });
});
