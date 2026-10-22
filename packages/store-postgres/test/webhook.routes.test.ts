import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { MAX_ROUTE_CHAIN, MAX_WEBHOOKS, UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { RouteChainError, RouteCycleError } from '../src/errors';
import { migrate } from '../src/schema/migrate';
import { MIGRATIONS } from '../src/schema/migrations';
import type { WebhookSpec } from '../src/store/webhookTypes';
import { resetTables } from './finishHelpers';
import type { FreshSchema } from './helpers';
import { freshSchema } from './helpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import { addHook, KEY, SECRET } from './webhookHelpers';

/** A queue route from `from` to `to`. */
const route = (
  from: string,
  to: string,
  extra: Partial<WebhookSpec> = {}
): Partial<WebhookSpec> => ({
  destination: 'queue',
  url: undefined,
  queue: from,
  target: to,
  events: ['job.completed'],
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

    test('webhooks that exist before it become http routes, and a release that predates it still writes them', async () => {
      const before = MIGRATIONS.filter((migration) => migration.version <= 15);
      await migrate(fresh.db, { migrations: before });
      await fresh.sql`
        INSERT INTO qcloud_webhooks (namespace, id, url, events, created_by, created_at)
        VALUES ('ns', 'old', 'https://hooks.example.com/in', ARRAY['job.failed'], 'op', 1)`;
      await migrate(fresh.db);
      // What the previous release does: it knows neither column.
      await fresh.sql`
        INSERT INTO qcloud_webhooks (namespace, id, url, events, created_by, created_at)
        VALUES ('ns', 'older', 'https://hooks.example.com/in', ARRAY['job.failed'], 'op', 1)`;
      const rows = await fresh.sql<
        Array<{ id: string; destination: string; target: string | null }>
      >`
        SELECT id, destination, target FROM qcloud_webhooks ORDER BY id`;
      expect(rows).toEqual([
        { id: 'old', destination: 'http', target: null },
        { id: 'older', destination: 'http', target: null },
      ]);
    });

    test('the table refuses a queue route without a target, an http route with one, and any other destination', async () => {
      await migrate(fresh.db);
      const insert = async (destination: string, target: string | null) => {
        await fresh.sql`
          INSERT INTO qcloud_webhooks (namespace, id, destination, url, target, events, created_by, created_at)
          VALUES ('ns', ${`w-${destination}-${target}`}, ${destination}, '', ${target}, ARRAY['job.failed'], 'op', 1)`;
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
      const queue = await addHook(t, route('orders', 'emails'));
      expect(queue).toMatchObject({
        destination: 'queue',
        target: 'emails',
        queue: 'orders',
        url: '',
      });
      expect(await t.store.webhooks.get(queue.id)).toMatchObject({
        id: queue.id,
        destination: 'queue',
        target: 'emails',
        queue: 'orders',
        url: '',
      });
      expect((await t.store.webhooks.list()).map((hook) => hook.destination)).toEqual([
        'http',
        'queue',
      ]);
    });

    test.each([
      ['a queue route without a target', route('a', 'b', { target: null })],
      ['a queue route without a source queue', route('a', 'b', { queue: null })],
      ['a queue route with a url', route('a', 'b', { url: 'https://hooks.example.com/in' })],
      ['an http route with a target', { target: 'b' }],
      ['an http route without a url', { url: undefined }],
      ['an unknown destination', { destination: 'workflow' as never, target: 'b', queue: 'a' }],
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
      const queue = await addHook(keyed, route('orders', 'emails'));
      expect(queue).toMatchObject({ secret: null, signed: false });
      expect(await keyed.store.webhooks.get(queue.id)).toMatchObject({ signed: false });
      const http = await addHook(keyed);
      expect(http.secret).toMatch(/^whsec_/);
      expect(http.signed).toBe(true);
    });

    test('a secret that is given is refused, and nothing is written', async () => {
      await expect(
        addHook(keyed, route('orders', 'emails', { secret: SECRET }))
      ).rejects.toBeInstanceOf(UnsupportedOptionError);
      expect(await keyed.store.webhooks.list()).toEqual([]);
    });

    test('rotating one is refused, and the route stays unsigned', async () => {
      const queue = await addHook(keyed, route('orders', 'emails'));
      await expect(keyed.store.webhooks.rotateSecret(queue.id)).rejects.toBeInstanceOf(
        UnsupportedOptionError
      );
      expect(await keyed.store.webhooks.get(queue.id)).toMatchObject({ signed: false });
    });
  });

  describe('loops are refused when a route is saved', () => {
    const listed = async () => (await t.store.webhooks.list()).length;

    test('a route from a queue to itself', async () => {
      await expect(addHook(t, route('a', 'a'))).rejects.toBeInstanceOf(RouteCycleError);
      expect(await listed()).toBe(0);
    });

    test('a route that closes a loop of two or three queues, and nothing is kept of it', async () => {
      await addHook(t, route('a', 'b'));
      await expect(addHook(t, route('b', 'a'))).rejects.toBeInstanceOf(RouteCycleError);
      await addHook(t, route('b', 'c'));
      await expect(addHook(t, route('c', 'a'))).rejects.toBeInstanceOf(RouteCycleError);
      expect(await listed()).toBe(2);
    });

    test('a fan-out, a diamond and an http route on the same queue are not loops', async () => {
      await addHook(t, route('a', 'b'));
      await addHook(t, route('a', 'c'));
      await addHook(t, route('b', 'd'));
      await addHook(t, route('c', 'd'));
      await addHook(t, { queue: 'd' });
      await addHook(t, { queue: 'a' });
      expect(await listed()).toBe(6);
    });

    test('a chain of five routes is saved and a sixth is refused', async () => {
      for (let i = 0; i < MAX_ROUTE_CHAIN; i++) await addHook(t, route(`q${i}`, `q${i + 1}`));
      await expect(addHook(t, route('q5', 'q6'))).rejects.toBeInstanceOf(RouteChainError);
      // The same chain made at its front, which only joins the two halves.
      await expect(addHook(t, route('q-1', 'q0'))).rejects.toBeInstanceOf(RouteChainError);
      expect(await listed()).toBe(MAX_ROUTE_CHAIN);
    });

    test('a disabled route counts, so it cannot be parked to be turned on into a loop later', async () => {
      await addHook(t, route('a', 'b'));
      await expect(addHook(t, route('b', 'a', { enabled: false }))).rejects.toBeInstanceOf(
        RouteCycleError
      );
    });

    test('another namespace has its own routes', async () => {
      await addHook(t, route('a', 'b'));
      await t.another({ namespace: 'other' }).webhooks.create(route('b', 'a') as WebhookSpec, 'op');
    });

    test('turning a route on checks the routes again', async () => {
      const first = await addHook(t, route('a', 'b', { enabled: false }));
      await addHook(t, route('b', 'c'));
      // A row no save made (a manual edit, or a release without the check) that now closes a loop.
      await t.fresh.sql`
        UPDATE qcloud_webhooks SET queue = 'c', target = 'b'
        WHERE id = ${first.id} AND namespace = 'test'`;
      await expect(t.store.webhooks.setEnabled(first.id, true)).rejects.toBeInstanceOf(
        RouteCycleError
      );
      expect((await t.store.webhooks.get(first.id))!.enabled).toBe(false);
      // Turning one off never needs the check, and an http route is not looked at.
      const http = await addHook(t);
      expect((await t.store.webhooks.setEnabled(http.id, false))!.enabled).toBe(false);
      expect((await t.store.webhooks.setEnabled(http.id, true))!.enabled).toBe(true);
    });

    test('two saves that would close a loop between them: one of them is refused', async () => {
      for (let round = 0; round < 8; round++) {
        await resetTables(t);
        const results = await Promise.allSettled([
          addHook(t, route('x', 'y')),
          addHook(t, route('y', 'z')),
          addHook(t, route('z', 'x')),
        ]);
        const refused = results.filter((r) => r.status === 'rejected');
        expect(refused).toHaveLength(1);
        expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(RouteCycleError);
        expect(await listed()).toBe(2);
      }
    });

    test('the check reads every route, not a page of them', async () => {
      await Promise.all(
        Array.from({ length: MAX_WEBHOOKS - 1 }, (_, i) => addHook(t, route(`s${i}`, `t${i}`)))
      );
      await expect(addHook(t, route('t0', 's0'))).rejects.toBeInstanceOf(RouteCycleError);
    });
  });
});
