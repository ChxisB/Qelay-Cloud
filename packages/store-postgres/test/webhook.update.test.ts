import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import { addHook, KEY } from './webhookHelpers';

describeDb('webhooks: update', () => {
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

  const update = (id: string, patch: Parameters<typeof t.store.webhooks.update>[1]) =>
    t.store.webhooks.update(id, patch);
  const refused = async (run: Promise<unknown>, option: string) => {
    const error = await run.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    expect((error as UnsupportedOptionError).option).toBe(option);
  };

  test('a patch changes the fields it names and nothing else', async () => {
    const hook = await addHook(t, { name: 'First', description: 'Kept' });
    const named = await update(hook.id, { name: '  Second ' });
    expect(named).toMatchObject({ name: 'Second', description: 'Kept', source: hook.source });
    const rule = await update(hook.id, { filter: { 'body.kind': 'order' }, delayMs: 5_000 });
    expect(rule).toMatchObject({
      name: 'Second',
      filter: { 'body.kind': 'order' },
      delayMs: 5_000,
    });
    expect(rule).toMatchObject({ url: hook.url, signed: hook.signed, enabled: true });
    expect(await t.store.webhooks.get(hook.id)).toEqual(rule);
  });

  test('null clears a name, a description and the rules', async () => {
    const hook = await addHook(t, {
      name: 'x',
      description: 'y',
      filter: { 'body.kind': 'a' },
      shape: { id: { $: 'body.id' } },
      delayMs: 5_000,
      dedupe: { windowMs: 5_000, fields: ['body.id'] },
    });
    const cleared = await update(hook.id, {
      name: null,
      description: null,
      filter: null,
      shape: null,
      delayMs: null,
      dedupe: null,
    });
    expect(cleared).toMatchObject({
      name: null,
      description: null,
      filter: null,
      shape: null,
      delayMs: null,
      dedupe: null,
    });
  });

  test('an empty patch and a bad value are refused and write nothing', async () => {
    const hook = await addHook(t, { name: 'Keep' });
    await refused(update(hook.id, {}), 'patch');
    await refused(update(hook.id, { name: 'a\u0001b' }), 'name');
    await refused(update(hook.id, { name: 'ok', delayMs: 5 }), 'delayMs');
    await refused(update(hook.id, { filter: { queue: 'a' } }), 'filter');
    await refused(update(hook.id, { source: 'missing' }), 'source');
    await refused(update(hook.id, { events: ['request.received'] } as never), 'patch');
    expect((await t.store.webhooks.get(hook.id))!.name).toBe('Keep');
  });

  test('null for a webhook that does not exist', async () => {
    expect(await update('nope', { name: 'x' })).toBeNull();
  });

  test('another webhook is not touched', async () => {
    const a = await addHook(t, { name: 'a' });
    const b = await addHook(t, { name: 'b' });
    await update(a.id, { name: 'a2' });
    expect((await t.store.webhooks.get(b.id))!.name).toBe('b');
  });
});
