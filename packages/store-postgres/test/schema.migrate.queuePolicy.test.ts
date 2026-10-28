import { afterEach, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { migrate } from '../src/schema/migrate';
import { MIGRATIONS } from '../src/schema/migrations';
import type { FreshSchema } from './helpers';
import { freshSchema } from './helpers';

/** The SQLSTATE a statement ends with, or null when it succeeds. Only 23514 passes for a failed check. */
const failure = (query: PromiseLike<unknown>) =>
  Promise.resolve(query).then(
    () => null,
    (error: unknown) => (error as { errno?: string }).errno ?? 'unknown'
  );

const CHECK_VIOLATION = '23514';

const upTo = (version: number) => MIGRATIONS.filter((m) => m.version <= version);

describeDb('schema migrate: queue policy and run window (version 23)', () => {
  let fresh: FreshSchema;
  beforeEach(async () => {
    fresh = await freshSchema();
  });
  afterEach(async () => {
    await fresh.drop();
  });

  test('a database at version 22 keeps its queue rows, applies without drift, and the release before still writes them', async () => {
    await migrate(fresh.db, { migrations: upTo(22) });
    await fresh.sql`
      INSERT INTO qcloud_queue_state (namespace, queue, paused, concurrency_limit)
      VALUES ('ns', 'old', TRUE, 4)`;

    expect((await migrate(fresh.db, { migrations: upTo(23) })).to).toBe(23);
    // A second run checks the recorded checksum of every version, this one's included.
    expect((await migrate(fresh.db, { migrations: upTo(23) })).to).toBe(23);

    // What the release before this one runs: an insert and an update that name none of the new columns.
    await fresh.sql`INSERT INTO qcloud_queue_state (namespace, queue) VALUES ('ns', 'older-release')`;
    await fresh.sql`
      UPDATE qcloud_queue_state SET paused = TRUE, rate_count = rate_count + 1
      WHERE namespace = 'ns' AND queue = 'older-release'`;

    const rows = await fresh.sql<
      Array<{
        queue: string;
        paused: boolean;
        policy: unknown;
        run_window: unknown;
        window_from: unknown;
      }>
    >`SELECT queue, paused, policy, run_window, window_from FROM qcloud_queue_state ORDER BY queue`;
    expect(rows).toEqual([
      { queue: 'old', paused: true, policy: null, run_window: null, window_from: null },
      { queue: 'older-release', paused: true, policy: null, run_window: null, window_from: null },
    ]);
  });

  test('a policy and a window are stored, and the checks hold', async () => {
    await migrate(fresh.db);
    await fresh.sql`
      INSERT INTO qcloud_queue_state
        (namespace, queue, policy, run_window, window_from, window_until)
      VALUES ('ns', 'nightly',
        '{"attempts":5,"backoff":{"type":"fixed","delayMs":1000},"timeout":30000}'::jsonb,
        '{"cron":"0 0 * * *","durationMs":3600000,"timezone":"Europe/London"}'::jsonb,
        1000, 4600000)`;
    const [row] = await fresh.sql<Array<{ attempts: number; cron: string }>>`
      SELECT (policy->>'attempts')::int AS attempts, run_window->>'cron' AS cron
      FROM qcloud_queue_state WHERE queue = 'nightly'`;
    expect(row).toEqual({ attempts: 5, cron: '0 0 * * *' });

    const insert = (queue: string, columns: string, values: string) =>
      failure(
        fresh.sql.unsafe(
          `INSERT INTO qcloud_queue_state (namespace, queue, ${columns}) VALUES ('ns', '${queue}', ${values})`
        )
      );
    const WINDOW = `'{"cron":"@daily","durationMs":1000}'::jsonb`;
    // A policy or a window that is not an object.
    expect(await insert('p1', 'policy', `'[1]'::jsonb`)).toBe(CHECK_VIOLATION);
    expect(await insert('p2', 'run_window', `'"daily"'::jsonb`)).toBe(CHECK_VIOLATION);
    // A window with no interval, an interval with no window, an interval with one end, an empty or backwards interval.
    expect(await insert('w1', 'run_window', WINDOW)).toBe(CHECK_VIOLATION);
    expect(await insert('w2', 'window_from, window_until', '1, 2')).toBe(CHECK_VIOLATION);
    expect(await insert('w3', 'run_window, window_from', `${WINDOW}, 1`)).toBe(CHECK_VIOLATION);
    expect(await insert('w4', 'run_window, window_from, window_until', `${WINDOW}, 5, 5`)).toBe(
      CHECK_VIOLATION
    );
    expect(await insert('w5', 'run_window, window_from, window_until', `${WINDOW}, 5, 4`)).toBe(
      CHECK_VIOLATION
    );
    expect(
      await insert('ok', 'run_window, window_from, window_until', `${WINDOW}, 5, 6`)
    ).toBeNull();
  });
});
