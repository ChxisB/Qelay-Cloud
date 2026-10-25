import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { checkBackupPolicy } from '../src';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

describe('checkBackupPolicy', () => {
  test('the provider and none carry no tool or location; external needs a tool', () => {
    expect(checkBackupPolicy({ mechanism: 'provider' })).toBeNull();
    expect(checkBackupPolicy({ mechanism: 'none', tool: ' ', location: null })).toBeNull();
    expect(checkBackupPolicy({ mechanism: 'external', tool: 'pgBackRest' })).toBeNull();
    expect(checkBackupPolicy({ mechanism: 'provider', tool: 'pgBackRest' })?.field).toBe('tool');
    expect(checkBackupPolicy({ mechanism: 'none', location: 'gs://x' })?.field).toBe('location');
    expect(checkBackupPolicy({ mechanism: 'external' })?.field).toBe('tool');
    expect(checkBackupPolicy({ mechanism: 'external', tool: '   ' })?.field).toBe('tool');
    expect(checkBackupPolicy({ mechanism: 'external', tool: 'x'.repeat(201) })?.field).toBe('tool');
    expect(
      checkBackupPolicy({ mechanism: 'external', tool: 'x', location: 'y'.repeat(501) })?.field
    ).toBe('location');
    expect(checkBackupPolicy({ mechanism: 's3' as 'none' })?.field).toBe('mechanism');
  });
});

describeDb('backup policy: the declaration', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.fresh.sql`DELETE FROM qcloud_backup_policy`;
  });

  test('nobody has said: null. Then each declaration replaces the one before, and the extra fields go with a mechanism that has none', async () => {
    expect(await t.store.backups.get()).toBeNull();

    const own = await t.store.backups.set(
      { mechanism: 'external', tool: '  pgBackRest ', location: ' gs://acme-backups/qelay ' },
      'alice'
    );
    expect(own).toMatchObject({
      mechanism: 'external',
      tool: 'pgBackRest',
      location: 'gs://acme-backups/qelay',
      updatedBy: 'alice',
    });
    expect(own.updatedAt).toBeGreaterThan(0);
    expect(await t.store.backups.get()).toEqual(own);

    const managed = await t.store.backups.set({ mechanism: 'provider' }, 'bob');
    expect(managed).toMatchObject({
      mechanism: 'provider',
      tool: null,
      location: null,
      updatedBy: 'bob',
    });
    expect(managed.updatedAt).toBeGreaterThanOrEqual(own.updatedAt);
    const rows = await t.fresh.sql<Array<{ n: number | string }>>`
      SELECT count(*) AS n FROM qcloud_backup_policy`;
    expect(Number(rows[0]!.n)).toBe(1);
  });

  test('a spec that breaks a rule is refused before anything is written', async () => {
    await expect(
      t.store.backups.set({ mechanism: 'external', tool: '' }, 'alice')
    ).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(
      t.store.backups.set({ mechanism: 'provider', location: 'gs://x' }, 'alice')
    ).rejects.toBeInstanceOf(UnsupportedOptionError);
    expect(await t.store.backups.get()).toBeNull();
  });

  test('the table refuses a row the store would not write, whoever writes it', async () => {
    // Awaited inside an async function: `expect(query).rejects` on a lazy Bun.SQL query spins forever.
    const insert = async (mechanism: string, tool: string | null, location: string | null) => {
      await t.fresh.sql`
        INSERT INTO qcloud_backup_policy (namespace, mechanism, tool, location, updated_by, updated_at)
        VALUES ('other', ${mechanism}, ${tool}, ${location}, 'x', 1)`;
    };
    await expect(insert('external', null, null)).rejects.toThrow();
    await expect(insert('provider', 'pgBackRest', null)).rejects.toThrow();
    await expect(insert('none', null, 'gs://x')).rejects.toThrow();
    await expect(insert('s3', null, null)).rejects.toThrow();
  });
});
