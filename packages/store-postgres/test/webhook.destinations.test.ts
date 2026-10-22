import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { MAX_DESTINATIONS, UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import {
  DestinationInUseError,
  DestinationLimitError,
  DestinationNameTakenError,
  RouteCycleError,
} from '../src/errors';
import type { DestinationSpec } from '../src/store/webhookDestinationTypes';
import type { WebhookSpec } from '../src/store/webhookTypes';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import { addHook, KEY } from './webhookHelpers';

const BILLING = { name: 'Billing', kind: 'http', url: 'https://billing.example.com/in' } as const;
const refused = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);

describeDb('saved destinations (migration 19)', () => {
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

  const save = (spec: DestinationSpec = BILLING) => t.store.webhooks.createDestination(spec, 'me');
  const made = (id: string, extra: Partial<WebhookSpec> = {}) =>
    addHook(t, { url: undefined, destinationId: id, ...extra });
  const queueRoute = (from: string, to: string) =>
    addHook(t, { destination: 'queue', url: undefined, queue: from, target: to });

  describe('saving and reading', () => {
    test('a destination is saved with its address, listed oldest first and read by id', async () => {
      const first = await save({ name: '  Billing ', kind: 'http', url: BILLING.url });
      t.clock.advance(5);
      const second = await save({ name: 'Orders', kind: 'queue', target: 'orders' });
      expect(first).toMatchObject({
        name: 'Billing',
        kind: 'http',
        url: BILLING.url,
        target: null,
        connections: 0,
        createdBy: 'me',
      });
      expect(second).toMatchObject({ kind: 'queue', url: null, target: 'orders' });
      expect(second.createdAt).toBeGreaterThan(first.createdAt);
      expect((await t.store.webhooks.destinations()).map((d) => d.id)).toEqual([
        first.id,
        second.id,
      ]);
      expect(await t.store.webhooks.getDestination(second.id)).toEqual(second);
      expect(await t.store.webhooks.getDestination('nope')).toBeNull();
    });

    test('a name, a kind and an address that do not fit are refused, and nothing is written', async () => {
      const bad: Array<[Record<string, unknown>, string]> = [
        [{ ...BILLING, name: '   ' }, 'name'],
        [{ ...BILLING, name: undefined }, 'name'],
        [{ ...BILLING, kind: 'workflow' }, 'kind'],
        [{ name: 'a', kind: 'http' }, 'url'],
        [{ name: 'a', kind: 'http', url: 'https://x.example.com/', target: 'q' }, 'target'],
        [{ name: 'a', kind: 'queue' }, 'target'],
        [{ name: 'a', kind: 'queue', target: 'q', url: 'https://x.example.com/' }, 'url'],
      ];
      for (const [spec, option] of bad) {
        const error = await refused(save(spec as unknown as DestinationSpec));
        expect(error, JSON.stringify(spec)).toBeInstanceOf(UnsupportedOptionError);
        expect((error as UnsupportedOptionError).option).toBe(option);
      }
      expect(await t.store.webhooks.destinations()).toEqual([]);
    });

    test('names are unique, and the cap is MAX_DESTINATIONS', async () => {
      await save();
      const taken = await refused(save({ ...BILLING, url: 'https://other.example.com/' }));
      expect(taken).toBeInstanceOf(DestinationNameTakenError);
      await t.fresh.sql.unsafe(
        `INSERT INTO qcloud_webhook_destinations
           (namespace, id, name, kind, url, created_by, created_at, updated_at)
         SELECT namespace, 'x' || g, 'filler ' || g, 'http', 'https://x.example.com/', 'me', g, g
         FROM (SELECT DISTINCT namespace FROM qcloud_webhook_destinations) n,
              generate_series(1, ${MAX_DESTINATIONS - 1}) g`
      );
      expect(await refused(save({ ...BILLING, name: 'one too many' }))).toBeInstanceOf(
        DestinationLimitError
      );
    });
  });

  describe('a webhook made from a destination', () => {
    test('copies the address, keeps the id, and is signed like any other', async () => {
      const billing = await save();
      const hook = await made(billing.id, { name: 'Orders to billing' });
      expect(hook).toMatchObject({
        destination: 'http',
        url: BILLING.url,
        target: null,
        destinationId: billing.id,
        signed: true,
      });
      expect(hook.secret).toEqual(expect.any(String));
      expect((await t.store.webhooks.get(hook.id))!.destinationId).toBe(billing.id);
      expect((await t.store.webhooks.getDestination(billing.id))!.connections).toBe(1);
      expect((await addHook(t)).destinationId).toBeNull();
    });

    test('a queue destination makes a queue route that needs its source queue', async () => {
      const orders = await save({ name: 'Orders', kind: 'queue', target: 'orders' });
      const hook = await made(orders.id, { queue: 'intake' });
      expect(hook).toMatchObject({
        destination: 'queue',
        url: '',
        target: 'orders',
        queue: 'intake',
      });
      expect(hook.secret).toBeNull();
      const error = await refused(made(orders.id));
      expect((error as UnsupportedOptionError).option).toBe('queue');
    });

    test('the address is the destination or the spec, not both; an unknown id is refused', async () => {
      const billing = await save();
      for (const extra of [
        { url: 'https://other.example.com/' },
        { target: 'q' },
        { destination: 'http' as const },
      ]) {
        const error = await refused(made(billing.id, extra));
        expect(error, JSON.stringify(extra)).toBeInstanceOf(UnsupportedOptionError);
        expect((error as UnsupportedOptionError).option).toBe('destinationId');
      }
      const missing = await refused(made('nope'));
      expect((missing as UnsupportedOptionError).option).toBe('destinationId');
      expect(await t.store.webhooks.list()).toEqual([]);
    });
  });

  describe('changing a destination', () => {
    test('a new address reaches every webhook made from it, and no other', async () => {
      const billing = await save();
      const [a, b] = [await made(billing.id), await made(billing.id)];
      const other = await addHook(t, { url: 'https://elsewhere.example.com/' });
      t.clock.advance(7);
      const moved = await t.store.webhooks.updateDestination(billing.id, {
        url: 'https://billing.example.com/v2',
      });
      expect(moved).toMatchObject({ url: 'https://billing.example.com/v2', connections: 2 });
      expect(moved!.updatedAt).toBeGreaterThan(billing.updatedAt);
      for (const id of [a.id, b.id]) {
        expect((await t.store.webhooks.get(id))!.url).toBe('https://billing.example.com/v2');
      }
      expect((await t.store.webhooks.get(other.id))!.url).toBe('https://elsewhere.example.com/');
    });

    test('a rename leaves the webhooks alone, and a taken name is refused', async () => {
      const billing = await save();
      const orders = await save({ name: 'Orders', kind: 'http', url: 'https://o.example.com/' });
      const hook = await made(billing.id);
      expect(
        (await t.store.webhooks.updateDestination(billing.id, { name: 'Billing' }))!.name
      ).toBe('Billing');
      expect(
        (await t.store.webhooks.updateDestination(billing.id, { name: 'Payments' }))!.name
      ).toBe('Payments');
      expect(
        await refused(t.store.webhooks.updateDestination(orders.id, { name: 'Payments' }))
      ).toBeInstanceOf(DestinationNameTakenError);
      expect((await t.store.webhooks.get(hook.id))!.url).toBe(BILLING.url);
    });

    test('an address of the other kind, an empty patch and an unknown id are refused or null', async () => {
      const billing = await save();
      const orders = await save({ name: 'Orders', kind: 'queue', target: 'orders' });
      const wrongUrl = await refused(
        t.store.webhooks.updateDestination(orders.id, { url: 'https://x.example.com/' })
      );
      expect((wrongUrl as UnsupportedOptionError).option).toBe('url');
      const wrongTarget = await refused(
        t.store.webhooks.updateDestination(billing.id, { target: 'q' })
      );
      expect((wrongTarget as UnsupportedOptionError).option).toBe('target');
      const empty = await refused(t.store.webhooks.updateDestination(billing.id, {}));
      expect((empty as UnsupportedOptionError).option).toBe('patch');
      expect(await t.store.webhooks.updateDestination('nope', { name: 'x' })).toBeNull();
      expect(await t.store.webhooks.getDestination(billing.id)).toEqual(billing);
    });

    test('a queue address that would make a loop is refused and nothing changes', async () => {
      const orders = await save({ name: 'Orders', kind: 'queue', target: 'b' });
      const hook = await made(orders.id, { queue: 'a' });
      await queueRoute('c', 'a');
      // a -> c with c -> a is a loop.
      const error = await refused(t.store.webhooks.updateDestination(orders.id, { target: 'c' }));
      expect(error).toBeInstanceOf(RouteCycleError);
      expect((await t.store.webhooks.getDestination(orders.id))!.target).toBe('b');
      expect((await t.store.webhooks.get(hook.id))!.target).toBe('b');
      const fine = await t.store.webhooks.updateDestination(orders.id, { target: 'd' });
      expect(fine!.target).toBe('d');
      expect((await t.store.webhooks.get(hook.id))!.target).toBe('d');
    });
  });

  describe('removing a destination', () => {
    test('one in use is refused until its webhooks are gone', async () => {
      const billing = await save();
      const hook = await made(billing.id);
      const error = await refused(t.store.webhooks.deleteDestination(billing.id));
      expect(error).toBeInstanceOf(DestinationInUseError);
      expect((error as DestinationInUseError).connections).toBe(1);
      expect(await t.store.webhooks.deleteDestination('nope')).toBe(false);
      expect(await t.store.webhooks.delete(hook.id)).toBe(true);
      expect(await t.store.webhooks.getDestination(billing.id)).not.toBeNull();
      expect(await t.store.webhooks.deleteDestination(billing.id)).toBe(true);
      expect(await t.store.webhooks.deleteDestination(billing.id)).toBe(false);
    });

    test('a webhook made while the destination is removed ends with one of them, never a dangling id', async () => {
      const billing = await save();
      const [create, remove] = await Promise.allSettled([
        made(billing.id),
        t.store.webhooks.deleteDestination(billing.id),
      ]);
      expect([create!.status, remove!.status].sort()).toEqual(['fulfilled', 'rejected']);
      const kept = await t.store.webhooks.getDestination(billing.id);
      expect(await t.store.webhooks.list()).toHaveLength(create!.status === 'fulfilled' ? 1 : 0);
      expect(kept === null).toBe(remove!.status === 'fulfilled');
    });
  });
});
