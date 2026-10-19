import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore } from './storeHelpers';
import { addHook, CLAIM, event, journal, journalHeld, KEY, rawDeliveries } from './webhookHelpers';

const HOUR = 3_600_000;

describeDb('webhooks: the delivery writer', () => {
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

  const hooks = t0();
  function t0() {
    return {
      write: () => t.store.webhooks.writeDeliveries(),
      start: () => t.store.webhooks.startWriter(),
      stop: () => t.store.webhooks.stopWriter(),
      state: () => t.store.webhooks.writerState(),
    };
  }
  const shape = async () =>
    (await rawDeliveries(t)).map((r) => [
      r.webhook_id,
      r.event_name,
      r.queue,
      r.job_id,
      r.event_id,
    ]);
  const stored = () =>
    t.fresh.sql<
      Array<{
        webhook_id: string;
        job_id: string;
        status: string;
        body: string | null;
        last_error: string | null;
      }>
    >`
      SELECT webhook_id, job_id, status, body, last_error FROM qcloud_deliveries ORDER BY id`;
  /** Puts the writer's cursor at the journal's start, as if it had consumed nothing. */
  const rewindWriter = () =>
    t.fresh
      .sql`INSERT INTO qcloud_webhook_writers (namespace, commit_seq, event_id, started_at, updated_at)
      VALUES ('test', 0, 0, 0, 0)
      ON CONFLICT (namespace) DO UPDATE SET commit_seq = 0, event_id = 0`;

  test('a pass makes the deliveries the trigger makes, for the same events', async () => {
    await addHook(t);
    await addHook(t, { queue: 'a', events: ['job.pushed', 'job.progress', 'job.completed'] });
    await journal(t, [
      event('pushed', 'a', 'j1'),
      event('pulled', 'b', 'j2'),
      event('progress', 'a', 'j3', { progress: 40 }),
      event('removed', 'a', 'j4'),
      event('completed', 'a', 'j5'),
      event('pushed', 'b', 'j6'),
    ]);
    const byTrigger = await shape();
    expect(byTrigger.length).toBe(8);
    await t.fresh.sql`TRUNCATE qcloud_deliveries`;
    await rewindWriter();
    expect(await hooks.write()).toMatchObject({ active: true, events: 6, written: 8, more: false });
    expect(await shape()).toEqual(byTrigger.map(([w, ...rest]) => [w, ...rest]).map((row) => row));
  });

  test('on: only what comes after the switch; a pass is once, and a restart keeps the cursor', async () => {
    await addHook(t);
    await journal(t, [event('pushed', 'q', 'before')]);
    expect(await hooks.start()).toMatchObject({ mode: 'writer' });
    const at = await hooks.state();
    await journal(t, [event('pushed', 'q', 'after')]);
    // The trigger stands aside for a namespace with a writer.
    expect(await rawDeliveries(t)).toHaveLength(1);
    expect(await hooks.write()).toMatchObject({ events: 1, written: 1 });
    expect(await hooks.write()).toMatchObject({ active: true, events: 0, written: 0 });
    expect((await stored()).map((r) => r.job_id)).toEqual(['before', 'after']);
    expect((await hooks.start()).commitSeq).toBeGreaterThan(at.commitSeq!);
  });

  test('an event the trigger already delivered is not made twice', async () => {
    await addHook(t);
    await journal(t, [event('pushed', 'q', 'j1')]);
    await rewindWriter();
    expect(await hooks.write()).toMatchObject({ events: 1, written: 0 });
    expect(await rawDeliveries(t)).toHaveLength(1);
  });

  test('off: nothing is lost, and the trigger takes over again', async () => {
    await addHook(t);
    await hooks.start();
    await journal(t, [event('pushed', 'q', 'j1'), event('pushed', 'q', 'j2')]);
    expect(await hooks.stop()).toMatchObject({ mode: 'trigger', commitSeq: null });
    expect((await stored()).map((r) => r.job_id)).toEqual(['j1', 'j2']);
    await journal(t, [event('pushed', 'q', 'j3')]);
    expect((await stored()).map((r) => r.job_id)).toEqual(['j1', 'j2', 'j3']);
    expect(await hooks.write()).toMatchObject({ active: false });
  });

  test('a job transaction in flight while the writer is switched off is waited for', async () => {
    await addHook(t);
    await hooks.start();
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    // The trigger stands aside (the writer is on) and this event commits after the stop began.
    const job = journalHeld(t, [event('pushed', 'q', 'late')], open);
    await Bun.sleep(100);
    const stopping = hooks.stop();
    await Bun.sleep(300);
    release();
    await job;
    await stopping;
    expect(await hooks.state()).toMatchObject({ mode: 'trigger' });
    expect((await stored()).map((r) => r.job_id)).toEqual(['late']);
  });

  test('a filter and a shape need the writer, and the writer cannot stop while they exist', async () => {
    const refused = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        return error;
      }
      return null;
    };
    expect(await refused(() => addHook(t, { filter: { queue: 'a' } }))).toBeInstanceOf(
      UnsupportedOptionError
    );
    await hooks.start();
    await addHook(t, { shape: { job: { $: 'jobId' } } });
    expect(await refused(hooks.stop)).toBeInstanceOf(UnsupportedOptionError);
    expect(await hooks.state()).toMatchObject({ mode: 'writer' });
    // Marked for stopping, no new filtered webhook.
    await t.fresh.sql`UPDATE qcloud_webhook_writers SET stopping = TRUE`;
    expect(await refused(() => addHook(t, { filter: { queue: 'a' } }))).toBeInstanceOf(
      UnsupportedOptionError
    );
  });

  test('a filter drops events, a shape makes the body once, and the claim carries it', async () => {
    await hooks.start();
    const a = await addHook(t, {
      filter: { queue: 'a' },
      shape: { kind: { $: 'event' }, job: { $: 'jobId' }, err: { $: 'error', default: 'none' } },
    });
    const b = await addHook(t);
    await journal(t, [
      event('pushed', 'a', 'j1'),
      event('failed', 'a', 'j2', { error: 'boom', state: 'failed' }),
      event('pushed', 'b', 'j3'),
    ]);
    expect(await hooks.write()).toMatchObject({ events: 3, written: 5 });
    const rows = await stored();
    expect(rows.filter((r) => r.webhook_id === a.id).map((r) => r.body)).toEqual([
      '{"err":"none","job":"j1","kind":"job.pushed"}',
      '{"err":"boom","job":"j2","kind":"job.failed"}',
    ]);
    expect(rows.filter((r) => r.webhook_id === b.id).map((r) => r.body)).toEqual([
      null,
      null,
      null,
    ]);
    const claimed = await t.store.webhooks.claimDue(CLAIM);
    expect(claimed.filter((c) => c.webhookId === a.id).map((c) => c.body)).toEqual(
      rows.filter((r) => r.webhook_id === a.id).map((r) => r.body)
    );
    expect(claimed.filter((c) => c.webhookId === b.id).every((c) => c.body === null)).toBe(true);
  });

  test('a body too large to make is a failed delivery with an empty body, not a lost one', async () => {
    await hooks.start();
    const big = await addHook(t, {
      shape: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`e${i}`, { $: 'error' }])),
    });
    await journal(t, [
      event('failed', 'q', 'j1', { error: '\u0001'.repeat(600), state: 'failed' }),
    ]);
    await hooks.write();
    const [row] = await stored();
    expect(row).toMatchObject({ webhook_id: big.id, status: 'failed', body: '' });
    expect(row!.last_error).toContain('larger than');
    expect(await t.store.webhooks.claimDue(CLAIM)).toEqual([]);
  });

  test('turning a webhook on does not replay what it missed while off', async () => {
    await hooks.start();
    const hook = await addHook(t);
    await t.store.webhooks.setEnabled(hook.id, false);
    await journal(t, [event('pushed', 'q', 'missed')]);
    t.clock.advance(1_000);
    await t.store.webhooks.setEnabled(hook.id, true);
    await journal(t, [event('pushed', 'q', 'seen')]);
    await hooks.write();
    expect((await stored()).map((r) => r.job_id)).toEqual(['seen']);
  });

  test('a reader behind pruned events is told, goes on, and the pruned ones are not delivered', async () => {
    const store = t.another({ eventRetentionMs: HOUR, maxQueueEvents: 5 });
    await addHook(t);
    await hooks.start();
    for (let i = 0; i < 3; i++) await enqueueN(store, 1);
    t.clock.advance(HOUR + 1);
    await enqueueN(store, 1);
    await store.events.trim();
    expect(await hooks.write()).toMatchObject({ gap: true, events: 0, more: true });
    expect(await hooks.write()).toMatchObject({ gap: false, events: 1, written: 1 });
    expect(await rawDeliveries(t)).toHaveLength(1);
  });

  test('a second writer while one holds the cursor does nothing', async () => {
    await hooks.start();
    const result = await t.fresh.sql.begin(async (tx) => {
      await tx`SELECT 1 FROM qcloud_webhook_writers WHERE namespace = 'test' FOR UPDATE`;
      return hooks.write();
    });
    expect(result).toMatchObject({ active: false });
  });
});
