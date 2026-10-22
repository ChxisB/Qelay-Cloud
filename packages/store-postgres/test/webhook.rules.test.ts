import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import { addHook, KEY } from './webhookHelpers';

describeDb('webhooks: name, delay and dedupe (migration 17)', () => {
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

  const refusal = async (run: Promise<unknown>, option: string) => {
    const error = await run.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    expect((error as UnsupportedOptionError).option).toBe(option);
  };

  test('none of them is required: a webhook made without them reads back with nulls', async () => {
    const { secret: _secret, ...hook } = await addHook(t);
    expect(hook).toMatchObject({ name: null, description: null, delayMs: null, dedupe: null });
  });

  test('a name and a description are kept trimmed, and blank means none', async () => {
    const { secret: _secret, ...hook } = await addHook(t, {
      name: '  Failed orders to billing ',
      description: 'Sends every failed order.\nSee the runbook.',
    });
    expect(hook).toMatchObject({
      name: 'Failed orders to billing',
      description: 'Sends every failed order.\nSee the runbook.',
    });
    expect(await t.store.webhooks.get(hook.id)).toEqual(hook);
    expect(await t.store.webhooks.list()).toEqual([hook]);
    expect(await addHook(t, { name: '   ', description: '' })).toMatchObject({
      name: null,
      description: null,
    });
  });

  test('a bad name, delay or dedupe is refused by name, and nothing is made', async () => {
    await refusal(addHook(t, { name: 'x'.repeat(81) }), 'name');
    await t.store.webhooks.startWriter();
    await refusal(addHook(t, { delayMs: 10 }), 'delayMs');
    await refusal(addHook(t, { dedupe: { windowMs: 60_000, fields: [] } }), 'dedupe');
    expect(await t.store.webhooks.list()).toEqual([]);
  });

  test('a delay or a dedupe needs the writer, as a filter does, and the writer then stays on', async () => {
    await refusal(addHook(t, { delayMs: 5_000 }), 'delayMs');
    await refusal(addHook(t, { dedupe: { windowMs: 60_000, fields: ['queue'] } }), 'dedupe');
    expect(await t.store.webhooks.list()).toEqual([]);

    await t.store.webhooks.startWriter();
    const delayed = await addHook(t, { delayMs: 5_000 });
    const deduped = await addHook(t, {
      dedupe: { windowMs: 60_000, fields: ['error', 'queue', 'error'] },
    });
    expect(delayed.delayMs).toBe(5_000);
    expect(deduped.dedupe).toEqual({ windowMs: 60_000, fields: ['queue', 'error'] });
    expect((await t.store.webhooks.get(deduped.id))?.dedupe).toEqual(deduped.dedupe);

    // `stopWriter` is refused while either rule is held (the trigger cannot apply them).
    await refusal(t.store.webhooks.stopWriter(), 'writer');
    await t.store.webhooks.delete(delayed.id);
    await refusal(t.store.webhooks.stopWriter(), 'writer');
    await t.store.webhooks.delete(deduped.id);
    expect((await t.store.webhooks.stopWriter()).mode).toBe('trigger');
  });
});
