import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { AUDIT_PRUNE_INTERVAL_MS } from '../src/store/audit';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore, START } from './storeHelpers';

const WHO = { subject: 'alice@example.com', role: 'operator', source: 'oidc' };

const intent = (n: number, action = 'POST /queues/:queue/pause', target = 'queue=emails') => ({
  ...WHO,
  requestId: `req-${String(n).padStart(8, '0')}`,
  action,
  target,
});

describeDb('operator audit log', () => {
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

  test('an operation is written as pending first and closed with its outcome', async () => {
    const id = await t.store.audit.begin(intent(1));
    const [open] = (await t.store.audit.list()).items;
    expect(open).toMatchObject({
      id,
      subject: 'alice@example.com',
      role: 'operator',
      source: 'oidc',
      requestId: 'req-00000001',
      action: 'POST /queues/:queue/pause',
      target: 'queue=emails',
      outcome: 'pending',
      occurredAt: START,
      finishedAt: null,
      status: null,
      reason: null,
    });
    t.clock.advance(40);
    expect(await t.store.audit.finish(id, { outcome: 'success', status: 200 })).toBe(true);
    const [closed] = (await t.store.audit.list()).items;
    expect(closed).toMatchObject({ id, outcome: 'success', status: 200, finishedAt: START + 40 });
  });

  test('closing an entry can complete its target with what the operation learned', async () => {
    const id = await t.store.audit.begin(intent(1, 'POST /crons', ''));
    await t.store.audit.finish(id, { outcome: 'success', status: 200, target: 'cron=nightly' });
    const kept = await t.store.audit.begin(intent(2));
    await t.store.audit.finish(kept, { outcome: 'success', status: 200 });
    const entries = (await t.store.audit.list()).items;
    expect(entries.map((entry) => entry.target)).toEqual(['queue=emails', 'cron=nightly']);
  });

  test('a closed entry cannot be rewritten: the log is append-only', async () => {
    const id = await t.store.audit.begin(intent(1));
    await t.store.audit.finish(id, { outcome: 'failed', status: 500, reason: 'internal' });
    expect(await t.store.audit.finish(id, { outcome: 'success', status: 200 })).toBe(false);
    const [entry] = (await t.store.audit.list()).items;
    expect(entry).toMatchObject({ outcome: 'failed', status: 500, reason: 'internal' });
  });

  test('a refusal is written in one step, already closed, with its reason', async () => {
    const id = await t.store.audit.record(intent(2, 'DELETE /jobs/:id', 'id=abc'), {
      outcome: 'rejected',
      status: 403,
      reason: 'forbidden',
    });
    const [entry] = (await t.store.audit.list()).items;
    expect(entry).toMatchObject({
      id,
      outcome: 'rejected',
      status: 403,
      reason: 'forbidden',
      finishedAt: START,
    });
  });

  test('entries come newest first, in pages that continue from next', async () => {
    for (let n = 1; n <= 7; n += 1) await t.store.audit.begin(intent(n));
    const first = await t.store.audit.list({ limit: 3 });
    expect(first.items.map((entry) => entry.requestId)).toEqual([
      'req-00000007',
      'req-00000006',
      'req-00000005',
    ]);
    const second = await t.store.audit.list({ limit: 3, before: first.next! });
    expect(second.items.map((entry) => entry.requestId)).toEqual([
      'req-00000004',
      'req-00000003',
      'req-00000002',
    ]);
    const last = await t.store.audit.list({ limit: 3, before: second.next! });
    expect(last.items.map((entry) => entry.requestId)).toEqual(['req-00000001']);
    expect(last.next).toBeNull();
  });

  test('entries filter by subject, action and outcome', async () => {
    await t.store.audit.begin(intent(1));
    const other = await t.store.audit.begin({
      ...intent(2, 'DELETE /jobs/:id', 'id=x'),
      subject: 'bob@example.com',
    });
    await t.store.audit.finish(other, { outcome: 'success', status: 200 });
    expect((await t.store.audit.list({ subject: 'bob@example.com' })).items).toHaveLength(1);
    expect((await t.store.audit.list({ action: 'POST /queues/:queue/pause' })).items).toHaveLength(
      1
    );
    expect((await t.store.audit.list({ outcome: 'success' })).items).toHaveLength(1);
    expect((await t.store.audit.list({ outcome: 'pending' })).items).toHaveLength(1);
    expect((await t.store.audit.list({ subject: 'nobody' })).items).toHaveLength(0);
  });

  test('a namespace sees only its own entries', async () => {
    const other = t.another({ namespace: 'other' });
    await t.store.audit.begin(intent(1));
    await other.audit.begin(intent(2));
    expect((await t.store.audit.list()).items.map((entry) => entry.requestId)).toEqual([
      'req-00000001',
    ]);
    expect((await other.audit.list()).items.map((entry) => entry.requestId)).toEqual([
      'req-00000002',
    ]);
  });

  test('hostile and oversized values are cut and stored, not refused', async () => {
    await t.store.audit.begin({
      subject: `${'s'.repeat(1_000)}\0`,
      role: 'operator',
      source: 'oidc',
      requestId: 'r'.repeat(500),
      action: 'a'.repeat(500),
      target: `queue=${'q'.repeat(2_000)}\0`,
    });
    const [entry] = (await t.store.audit.list()).items;
    expect(entry!.subject.length).toBe(256);
    expect(entry!.requestId.length).toBe(64);
    expect(entry!.action.length).toBe(160);
    expect(entry!.target.length).toBe(512);
    expect(entry!.target.includes('\0')).toBe(false);
  });

  test('a bad page request is refused', async () => {
    await expect(t.store.audit.list({ limit: 0 })).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(t.store.audit.list({ limit: 501 })).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(t.store.audit.list({ before: 0 })).rejects.toBeInstanceOf(UnsupportedOptionError);
  });

  test('prune deletes entries past the age, oldest first, and keeps the rest', async () => {
    const aged = t.another({ auditRetentionMs: 10_000 });
    await aged.audit.begin(intent(1));
    t.clock.advance(6_000);
    await aged.audit.begin(intent(2));
    t.clock.advance(6_000);
    expect(await aged.audit.prune()).toBe(1);
    expect((await aged.audit.list()).items.map((entry) => entry.requestId)).toEqual([
      'req-00000002',
    ]);
  });

  test('prune keeps the newest entries up to the count cap', async () => {
    const capped = t.another({ maxAuditEntries: 4 });
    for (let n = 1; n <= 9; n += 1) await capped.audit.begin(intent(n));
    // Appends prune at most once an interval, so the log may be over its cap until the next prune.
    await capped.audit.prune();
    expect((await capped.audit.list()).items.map((entry) => entry.requestId)).toEqual([
      'req-00000009',
      'req-00000008',
      'req-00000007',
      'req-00000006',
    ]);
  });

  test('an append that crosses the interval prunes, so no process has to', async () => {
    const capped = t.another({ maxAuditEntries: 3 });
    for (let n = 1; n <= 6; n += 1) await capped.audit.begin(intent(n));
    // The first append pruned an empty log; the rest came inside the interval.
    expect((await capped.audit.list()).items).toHaveLength(6);
    t.clock.advance(AUDIT_PRUNE_INTERVAL_MS);
    await capped.audit.begin(intent(7));
    expect((await capped.audit.list()).items.map((entry) => entry.requestId)).toEqual([
      'req-00000007',
      'req-00000006',
      'req-00000005',
    ]);
  });

  test('prune of a bounded batch leaves the rest for the next one', async () => {
    const capped = t.another({ maxAuditEntries: 2 });
    for (let n = 1; n <= 8; n += 1) await capped.audit.begin(intent(n));
    expect(await capped.audit.prune(3)).toBe(3);
    expect((await capped.audit.list()).items).toHaveLength(5);
    expect(await capped.audit.prune(3)).toBe(3);
    expect(await capped.audit.prune(3)).toBe(0);
    expect((await capped.audit.list()).items).toHaveLength(2);
  });
});
