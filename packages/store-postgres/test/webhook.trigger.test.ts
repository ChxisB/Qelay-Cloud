import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { JOURNAL_TO_WEBHOOK } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { WEBHOOK_FUNCTION_BODY } from '../src/schema/ddl/webhooks';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import { addHook, event, journal, names, rawDeliveries } from './webhookHelpers';

describeDb('webhooks: deliveries are made by the event journal', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ webhookKey: '00'.repeat(32) });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  test("the trigger's event table is core's, entry for entry", () => {
    const rows = [...WEBHOOK_FUNCTION_BODY.matchAll(/\('(\w+)', '([\w.]+)'\)/gu)];
    expect(
      Object.fromEntries(rows.map(([, journalType, webhook]) => [journalType, webhook]))
    ).toEqual(JOURNAL_TO_WEBHOOK);
  });

  test('every journal event type is either delivered under its webhook name or not at all', async () => {
    await addHook(t);
    const types = [
      'pushed',
      'duplicated',
      'updated',
      'promoted',
      'priority',
      'removed',
      'pulled',
      'released',
      'completed',
      'retried',
      'stalled',
      'failed',
      'progress',
      'obliterated',
    ] as const;
    await journal(
      t,
      types.map((type, index) => event(type, 'q', `j${index}`))
    );
    const delivered = Object.fromEntries(
      (await rawDeliveries(t)).map((row) => [row.job_id, row.event_name])
    );
    const expected = Object.fromEntries(
      types.flatMap((type, index) =>
        JOURNAL_TO_WEBHOOK[type] === undefined ? [] : [[`j${index}`, JOURNAL_TO_WEBHOOK[type]]]
      )
    );
    expect(delivered).toEqual(expected);
  });

  test('a webhook gets the events it subscribed to and none other', async () => {
    const done = await addHook(t, { events: ['job.completed', 'job.failed'] });
    await journal(t, [event('pushed'), event('completed', 'q', 'j2'), event('failed', 'q', 'j3')]);
    const rows = await rawDeliveries(t);
    expect(rows.map((row) => [row.webhook_id, row.event_name, row.job_id])).toEqual([
      [done.id, 'job.completed', 'j2'],
      [done.id, 'job.failed', 'j3'],
    ]);
  });

  test('the queue filter keeps other queues out, and no filter takes every queue', async () => {
    const only = await addHook(t, { queue: 'emails' });
    const all = await addHook(t);
    await journal(t, [event('pushed', 'emails', 'a'), event('pushed', 'other', 'b')]);
    const rows = await rawDeliveries(t);
    expect(rows.filter((row) => row.webhook_id === only.id).map((row) => row.queue)).toEqual([
      'emails',
    ]);
    expect(rows.filter((row) => row.webhook_id === all.id).map((row) => row.queue)).toEqual([
      'emails',
      'other',
    ]);
  });

  test('a disabled webhook gets nothing, and enabling it later does not replay the past', async () => {
    const hook = await addHook(t, { enabled: false });
    await journal(t, [event('pushed', 'q', 'early')]);
    expect(await rawDeliveries(t)).toEqual([]);
    await t.store.webhooks.setEnabled(hook.id, true);
    await journal(t, [event('pushed', 'q', 'late')]);
    expect((await rawDeliveries(t)).map((row) => row.job_id)).toEqual(['late']);
  });

  test('a delivery is created pending and due when the event happened, with the event it came from', async () => {
    await addHook(t);
    await journal(t, [event('pushed')]);
    const [row] = await rawDeliveries(t);
    expect(row).toMatchObject({ status: 'pending', attempts: 0, attempt_base: 0 });
    expect(Number(row!.next_attempt_at)).toBe(t.clock.now());
    const [journaled] = await t.fresh.sql<
      Array<{ id: string }>
    >`SELECT id::text FROM qcloud_events`;
    expect(row!.event_id).toBe(journaled!.id);
  });

  test('an event that rolled back leaves no delivery', async () => {
    await addHook(t);
    await t.fresh.sql
      .begin(async (tx) => {
        await tx`INSERT INTO qcloud_events (namespace, queue, event_type, job_id, occurred_at)
                 VALUES ('test', 'q', 'pushed', 'ghost', ${t.clock.now()})`;
        throw new Error('rolled back');
      })
      .catch(() => {});
    expect(await rawDeliveries(t)).toEqual([]);
  });

  test('another namespace has its own webhooks and its events reach only them', async () => {
    const mine = await addHook(t);
    const theirs = await t
      .another({ namespace: 'other' })
      .webhooks.create(
        { url: 'https://hooks.example.com/theirs', events: ['job.pushed'] },
        'tester'
      );
    await journal(t, [event('pushed')]);
    expect((await rawDeliveries(t)).map((row) => row.webhook_id)).toEqual([mine.id]);
    expect(theirs.id).not.toBe(mine.id);
  });

  test('a test delivery is its own event name and needs no journal event', async () => {
    const hook = await addHook(t, { events: ['job.progress'] });
    const sent = await t.store.webhooks.sendTest(hook.id);
    expect(sent).toMatchObject({ event: 'webhook.test', queue: 'webhook-test', status: 'pending' });
    expect(await names(t)).toEqual(['webhook.test']);
  });
});
