import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { ExecutionExistsError, ExecutionStaleError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { execution, ids, T0 } from '../../../test/support/workflow';
import { ExecutionTooLargeError, MAX_EXECUTION_BLOB_BYTES } from '../src';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

describeDb('PostgresStore.workflows: limits, namespaces and what survives the codec', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.fresh.sql`TRUNCATE qcloud_workflow_executions, qcloud_workflow_executions_archive`;
    t.clock.advance(T0 - t.clock.now());
  });

  const rows = async () => {
    const [row] = await t.fresh.sql`SELECT count(*)::int AS n FROM qcloud_workflow_executions`;
    return row.n as number;
  };
  const big = () => 'x'.repeat(MAX_EXECUTION_BLOB_BYTES + 1);

  test('an input over the column limit is refused on save and nothing is written', async () => {
    const refused = await t.store.workflows
      .save(execution(t.clock, 'e1', { input: big() }))
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ExecutionTooLargeError);
    expect(refused).toMatchObject({
      executionId: 'e1',
      column: 'input',
      limit: MAX_EXECUTION_BLOB_BYTES,
    });
    expect(await rows()).toBe(0);
  });

  test('steps over the limit are refused on update and the stored run is as it was', async () => {
    await t.store.workflows.save(execution(t.clock, 'e1'));
    const mine = (await t.store.workflows.get('e1'))!;
    mine.steps = { s: { status: 'completed', result: big() } as never };
    mine.state = 'completed';
    await expect(t.store.workflows.update(mine)).rejects.toBeInstanceOf(ExecutionTooLargeError);
    const stored = (await t.store.workflows.get('e1'))!;
    expect([stored.state, stored.version, stored.steps]).toEqual(['running', 0, {}]);
  });

  test('a signal over the limit is refused and the run keeps what it had', async () => {
    await t.store.workflows.save(execution(t.clock, 'e1'));
    await t.store.workflows.recordSignal('e1', 'first', 1);
    await expect(t.store.workflows.recordSignal('e1', 'second', big())).rejects.toBeInstanceOf(
      ExecutionTooLargeError
    );
    expect((await t.store.workflows.get('e1'))!.signals).toEqual({ first: 1 });
  });

  test('a timeout that cannot be encoded fails before it takes the run', async () => {
    await t.store.workflows.save(execution(t.clock, 'e1'));
    await t.store.workflows.parkForSignal('e1', 'go', t.clock.now() + 1);
    const copy = (await t.store.workflows.get('e1'))!;
    copy.state = 'failed';
    copy.steps = { s: { status: 'failed', error: big() } as never };
    await expect(t.store.workflows.expireWait(copy, 'go', 0)).rejects.toBeInstanceOf(
      ExecutionTooLargeError
    );
    expect((await t.store.workflows.get('e1'))!.state).toBe('waiting');
  });

  test('two namespaces on one schema do not see, change or clean each other', async () => {
    const other = t.another({ namespace: 'other' }).workflows;
    await t.store.workflows.save(execution(t.clock, 'shared', { workflowName: 'mine' }));
    expect(await other.get('shared')).toBeNull();
    await other.save(execution(t.clock, 'shared', { workflowName: 'theirs' }));
    await expect(other.save(execution(t.clock, 'shared'))).rejects.toBeInstanceOf(
      ExecutionExistsError
    );
    expect((await t.store.workflows.get('shared'))!.workflowName).toBe('mine');

    const mine = (await t.store.workflows.get('shared'))!;
    await other.remove('shared');
    await expect(other.update(mine)).rejects.toBeInstanceOf(ExecutionStaleError);
    expect(await t.store.workflows.get('shared')).not.toBeNull();

    await t.store.workflows.parkForSignal('shared', 'go', t.clock.now());
    expect(await other.claimDueWaits()).toEqual([]);
    expect(ids(await other.list())).toEqual([]);
    expect(ids(await t.store.workflows.list())).toEqual(['shared']);

    await other.save(execution(t.clock, 'old', { state: 'completed' }));
    t.clock.advance(10);
    expect(await t.store.workflows.archive(0, ['completed'])).toBe(0);
    expect(await other.archive(0, ['completed'])).toBe(1);
    expect(await other.getArchivedCount()).toBe(1);
    expect(await t.store.workflows.getArchivedCount()).toBe(0);
  });

  test('what the engine puts in a run comes back as it was put in', async () => {
    const when = new Date(1_700_000_000_000);
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1}') as unknown;
    const input = {
      when,
      tags: new Set(['a', 'b']),
      lookup: new Map<string, unknown>([['k', { n: 1n }]]),
      nothing: undefined,
      nul: null,
      hostile,
      nested: [[1, [2, [3]]]],
      error: new RangeError('nope'),
    };
    await t.store.workflows.save(execution(t.clock, 'e1', { input }));
    await t.store.workflows.recordSignal('e1', 'go', { at: when, big: 2n ** 70n });
    const stored = (await t.store.workflows.get('e1'))!;
    const got = stored.input as typeof input;
    expect(got.when).toEqual(when);
    expect([...got.tags]).toEqual(['a', 'b']);
    expect(got.lookup.get('k')).toEqual({ n: 1n });
    expect('nothing' in got).toBe(true);
    expect(got.nothing).toBeUndefined();
    expect(got.nul).toBeNull();
    expect(Object.hasOwn(got.hostile as object, '__proto__')).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(got.nested).toEqual([[1, [2, [3]]]]);
    expect(got.error).toBeInstanceOf(RangeError);
    expect((got.error as Error).message).toBe('nope');
    expect(stored.signals).toEqual({ go: { at: when, big: 2n ** 70n } });
  });

  test('recovery reads a bounded part of a large store, not all of it', async () => {
    await t.fresh.sql`
      INSERT INTO qcloud_workflow_executions
        (namespace, id, workflow_name, state, input, steps, current_node_index, signals, version, created_at, updated_at)
      SELECT 'test', 'p' || g, 'order', 'waiting', '\\x80'::bytea, '\\x80'::bytea, 0, '\\x80'::bytea, 0, ${T0}::bigint, ${T0}::bigint + g
      FROM generate_series(1, 20000) g`;
    t.clock.advance(1_000_000);
    const found = await t.store.workflows.listRecoverable({ limit: 5, idleMs: 0 });
    expect(ids(found)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    const idle = await t.store.workflows.listRecoverable({ limit: 5, idleMs: 999_990 });
    expect(ids(idle)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(await t.store.workflows.listRecoverable({ limit: 5, idleMs: 1_100_000 })).toEqual([]);
  });
});
