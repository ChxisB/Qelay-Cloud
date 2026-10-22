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
    const hook = await addHook(t, { name: 'First', description: 'Kept', queue: 'orders' });
    const named = await update(hook.id, { name: '  Second ' });
    expect(named).toMatchObject({ name: 'Second', description: 'Kept', queue: 'orders' });
    const events = await update(hook.id, { events: ['job.failed', 'job.failed', 'job.completed'] });
    expect(events).toMatchObject({ name: 'Second', events: ['job.failed', 'job.completed'] });
    expect(events).toMatchObject({ url: hook.url, signed: hook.signed, enabled: true });
    expect(await t.store.webhooks.get(hook.id)).toEqual(events);
  });

  test('null clears a name, a description and the rules', async () => {
    await t.store.webhooks.startWriter();
    const hook = await addHook(t, {
      name: 'x',
      description: 'y',
      filter: { queue: 'a' },
      shape: { id: { $: 'jobId' } },
      delayMs: 5_000,
      dedupe: { windowMs: 5_000, fields: ['event'] },
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

  test('an empty patch, a bad value and an empty event list are refused and write nothing', async () => {
    const hook = await addHook(t, { name: 'Keep' });
    await refused(update(hook.id, {}), 'patch');
    await refused(update(hook.id, { name: 'a\u0001b' }), 'name');
    await refused(update(hook.id, { name: 'ok', events: [] }), 'events');
    await refused(update(hook.id, { events: ['job.nope' as never] }), 'events');
    await refused(update(hook.id, { delayMs: 5 }), 'delayMs');
    expect((await t.store.webhooks.get(hook.id))!.name).toBe('Keep');
  });

  test('a rule only the writer applies is refused without it, and a name or events are not', async () => {
    const hook = await addHook(t);
    await refused(update(hook.id, { filter: { queue: 'a' } }), 'filter');
    await refused(update(hook.id, { shape: { id: { $: 'jobId' } } }), 'shape');
    await refused(update(hook.id, { delayMs: 5_000 }), 'delayMs');
    await refused(update(hook.id, { dedupe: { windowMs: 5_000, fields: ['event'] } }), 'dedupe');
    expect(await update(hook.id, { name: 'Fine', events: ['job.failed'] })).toMatchObject({
      name: 'Fine',
    });
    expect(await update(hook.id, { filter: null, delayMs: null })).toMatchObject({ filter: null });
  });

  test('with the writer on a rule is set, and the writer cannot then be switched off', async () => {
    await t.store.webhooks.startWriter();
    const hook = await addHook(t);
    expect(await update(hook.id, { delayMs: 5_000 })).toMatchObject({ delayMs: 5_000 });
    await refused(t.store.webhooks.stopWriter(), 'writer');
    await update(hook.id, { delayMs: null });
    expect(await t.store.webhooks.stopWriter()).toMatchObject({ mode: 'trigger' });
  });

  test('a name or events can change while the writer is stopping; a rule cannot be added', async () => {
    await t.store.webhooks.startWriter();
    const hook = await addHook(t, { delayMs: 5_000 });
    await t.fresh.sql`UPDATE qcloud_webhook_writers SET stopping = TRUE`;
    expect(await update(hook.id, { name: 'Still fine' })).toMatchObject({ name: 'Still fine' });
    await refused(update(hook.id, { dedupe: { windowMs: 5_000, fields: ['event'] } }), 'dedupe');
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
