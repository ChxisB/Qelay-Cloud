import { afterAll, beforeAll, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

/** The sweep for F19: `Bun.SQL` writes a null element of a TEXT array as the text "null", so a list of ids that holds a null must be refused, not matched. */
describeDb('typed arrays: a null element', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
    await t.store.enqueue([{ queue: 'q', name: 'n', data: 1, options: { jobId: 'null' } }]);
  });
  afterAll(async () => {
    await t.drop();
  });

  test('the driver turns a null into the text "null" (if this fails, the guards below can go)', async () => {
    const rows = await t.fresh.sql.begin(
      (tx) => tx`SELECT x FROM unnest(${tx.array(['a', null], 'TEXT')}) AS t(x)`
    );
    expect(rows.map((row: { x: string }) => row.x)).toEqual(['a', 'null']);
  });

  test.each([
    ['control.detailsMany', () => t.store.control.detailsMany([null as never])],
    ['control.failuresMany', () => t.store.control.failuresMany([null as never])],
    ['deployment.existing', () => t.store.deployment.existing([null as never])],
  ])('%s refuses a list with a null and does not match the job named "null"', async (_, call) => {
    await expect(call()).rejects.toBeInstanceOf(UnsupportedOptionError);
  });
});
