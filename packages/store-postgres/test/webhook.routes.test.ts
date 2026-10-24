import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { migrate } from '../src/schema/migrate';
import { MIGRATIONS } from '../src/schema/migrations';
import type { WebhookSpec } from '../src/store/webhookTypes';
import { resetTables } from './finishHelpers';
import type { FreshSchema } from './helpers';
import { freshSchema } from './helpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import { addHook, KEY, SECRET } from './webhookHelpers';

/** A queue route that adds a job to `to`. */
const route = (to: string, extra: Partial<WebhookSpec> = {}): Partial<WebhookSpec> => ({
  destination: 'queue',
  url: undefined,
  target: to,
  ...extra,
});

describeDb('webhook routes: the destination of a webhook (migration 16)', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  describe('the migration', () => {
    let fresh: FreshSchema;
    beforeEach(async () => {
      fresh = await freshSchema();
    });
    afterAll(async () => {
      await fresh?.drop();
    });

    test('webhooks that exist before it become http routes', async () => {
      const before = MIGRATIONS.filter((migration) => migration.version <= 15);
      await migrate(fresh.db, { migrations: before });
      await fresh.sql`
        INSERT INTO qcloud_webhooks (namespace, id, url, events, created_by, created_at)
        VALUES ('ns', 'old', 'https://hooks.example.com/in', ARRAY['job.failed'], 'op', 1)`;
      await migrate(fresh.db);
      const rows = await fresh.sql<
        Array<{ id: string; destination: string; target: string | null }>
      >`
        SELECT id, destination, target FROM qcloud_webhooks ORDER BY id`;
      expect(rows).toEqual([{ id: 'old', destination: 'http', target: null }]);
    });

    test('the table refuses a queue route without a target, an http route with one, and any other destination', async () => {
      await migrate(fresh.db);
      const insert = async (destination: string, target: string | null) => {
        await fresh.sql`
          INSERT INTO qcloud_webhooks (namespace, id, destination, url, target, created_by, created_at)
          VALUES ('ns', ${`w-${destination}-${target}`}, ${destination}, '', ${target}, 'op', 1)`;
      };
      await insert('queue', 'b');
      await expect(insert('queue', null)).rejects.toThrow();
      await expect(insert('http', 'b')).rejects.toThrow();
      await expect(insert('workflow', null)).rejects.toThrow();
    });
  });

  describe('saving a route', () => {
    test('an http route is the default and a queue route keeps its target, with an empty url', async () => {
      const http = await addHook(t);
      expect(http).toMatchObject({ destination: 'http', target: null });
      const queue = await addHook(t, route('emails'));
      expect(queue).toMatchObject({ destination: 'queue', target: 'emails', url: '' });
      expect(await t.store.webhooks.get(queue.id)).toMatchObject({
        id: queue.id,
        destination: 'queue',
        target: 'emails',
        url: '',
      });
      expect((await t.store.webhooks.list()).map((hook) => hook.destination)).toEqual([
        'http',
        'queue',
      ]);
    });

    test.each([
      ['a queue route without a target', route('b', { target: null })],
      ['a queue route with a url', route('b', { url: 'https://hooks.example.com/in' })],
      ['an http route with a target', { target: 'b' }],
      ['an http route without a url', { url: undefined }],
      ['an unknown destination', { destination: 'workflow' as never, target: 'b' }],
    ])('%s is refused with UnsupportedOptionError, and nothing is written', async (_name, bad) => {
      await expect(addHook(t, bad as Partial<WebhookSpec>)).rejects.toBeInstanceOf(
        UnsupportedOptionError
      );
      expect(await t.store.webhooks.list()).toEqual([]);
    });
  });

  describe('a queue route has no secret: no network is involved, so nothing is signed', () => {
    let keyed: TestStore;
    beforeAll(async () => {
      keyed = await openTestStore({ webhookKey: KEY });
    });
    afterAll(async () => {
      await keyed.drop();
    });
    beforeEach(async () => {
      await resetTables(keyed);
    });

    test('a store with a webhook key makes none for it, while an http route still gets one', async () => {
      const queue = await addHook(keyed, route('emails'));
      expect(queue).toMatchObject({ secret: null, signed: false });
      expect(await keyed.store.webhooks.get(queue.id)).toMatchObject({ signed: false });
      const http = await addHook(keyed);
      expect(http.secret).toMatch(/^whsec_/);
      expect(http.signed).toBe(true);
    });

    test('a secret that is given is refused, and nothing is written', async () => {
      await expect(addHook(keyed, route('emails', { secret: SECRET }))).rejects.toBeInstanceOf(
        UnsupportedOptionError
      );
      expect(await keyed.store.webhooks.list()).toEqual([]);
    });

    test('rotating one is refused, and the route stays unsigned', async () => {
      const queue = await addHook(keyed, route('emails'));
      await expect(keyed.store.webhooks.rotateSecret(queue.id)).rejects.toBeInstanceOf(
        UnsupportedOptionError
      );
      expect(await keyed.store.webhooks.get(queue.id)).toMatchObject({ signed: false });
    });
  });
});
