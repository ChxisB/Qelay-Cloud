import { afterEach, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { describeDb } from '../../../test/support/db';
import { createSchemaRole, directUrlFor, dropRole } from '../../../test/support/pooler';
import { workerRoleLimitSql } from '../src/connection/budget';
import { freshSchema } from './helpers';

/** The statement an operator runs for the workers' role (F14): the server, not the worker, refuses the extra connection. */
describeDb('connection: worker role limit', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step().catch(() => {});
  });

  test('a connection beyond the role limit is refused with 53300; the admin role still connects', async () => {
    const fresh = await freshSchema();
    const role = `qcloud_rl_${fresh.name.slice(-8)}`;
    await createSchemaRole(fresh.sql, role, fresh.name);
    await fresh.sql.unsafe(workerRoleLimitSql(role, 2));
    const held: SQL[] = [];
    cleanup.push(
      () => fresh.drop(),
      () => dropRole(fresh.sql, role),
      () => Promise.all(held.map((sql) => sql.close({ timeout: 1 })))
    );

    for (let n = 0; n < 2; n++) {
      const sql = new SQL(directUrlFor(role), { max: 1, connectionTimeout: 5, prepare: false });
      held.push(sql);
      await sql`SELECT 1`;
    }
    const third = new SQL(directUrlFor(role), { max: 1, connectionTimeout: 5, prepare: false });
    held.push(third);
    const error = await third`SELECT 1`.then(
      () => null,
      (reason: { errno?: string; code?: string }) => reason
    );
    expect(error?.errno ?? error?.code).toBe('53300');
    expect(await fresh.sql<Array<{ ok: number }>>`SELECT 1 AS ok`).toEqual([{ ok: 1 }]);
  });
});
