import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { budget, LATEST_VERSION } from '@qelay-cloud/store-postgres';
import { describeDb } from '../../../test/support/db';
import { enqueueN } from '../../store-postgres/test/storeHelpers';
import type { Wire } from './deploymentHarness';
import { deploymentHarness } from './deploymentHarness';
import type { JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';
import { fakeReadiness } from './support';

describeDb('GET /deployment', () => {
  let f: JobsFixture;
  beforeAll(async () => {
    f = await openJobsFixture();
  });
  afterAll(() => f.drop());
  beforeEach(() => f.reset());
  const { open, deployment, codes, tickedAgo } = deploymentHarness(() => f);
  const only = (body: Wire, code: string) =>
    body.warnings.filter((warning: Wire) => warning.code === code);

  test('reports the build, the schema against what the code expects, and the database', async () => {
    const body = await deployment(
      open({ version: '1.2.3', deployment: { commit: 'a1b2c3d' } }, { readiness: tickedAgo(1_000) })
    );
    expect(body).toMatchObject({
      ok: true,
      version: '1.2.3',
      commit: 'a1b2c3d',
      production: false,
      schema: { current: LATEST_VERSION, expected: LATEST_VERSION, state: 'current' },
      database: { state: 'ok' },
      transport: { name: 'memory', state: 'ok' },
    });
    expect(body.database.latencyMs).toBeGreaterThanOrEqual(0);
  });

  describe('tick', () => {
    test.each([
      [1_000, 'ok', []],
      [90_000, 'late', ['tick_late']],
      [6 * 60_000, 'stale', ['tick_stale']],
    ])('a tick %d ms old is %s', async (agoMs, state, expected) => {
      const body = await deployment(open({}, { readiness: tickedAgo(agoMs) }));
      expect(body.tick).toMatchObject({
        state,
        ageMs: agoMs,
        lateAfterMs: 60_000,
        staleAfterMs: 300_000,
      });
      expect(codes(body).filter((code) => code.startsWith('tick_'))).toEqual(expected);
    });

    test('a stale tick is critical and says how long it has been', async () => {
      const body = await deployment(open({}, { readiness: tickedAgo(6 * 60_000) }));
      expect(body.warnings).toContainEqual({
        code: 'tick_stale',
        severity: 'critical',
        message: expect.stringContaining('5 minutes'),
      });
    });

    test('a tick that never completed is critical, and its age is unknown, not zero', async () => {
      const body = await deployment(open({}, { readiness: tickedAgo(null) }));
      expect(body.tick).toMatchObject({ state: 'never', ageMs: null, lastSuccessAt: null });
      expect(body.warnings).toContainEqual(
        expect.objectContaining({ code: 'tick_never_ran', severity: 'critical' })
      );
    });

    test('a tick row that cannot be read is unknown, with a warning', async () => {
      const body = await deployment(
        open({}, { readiness: fakeReadiness({ tick: async () => null }) })
      );
      expect(body.tick).toMatchObject({ state: 'unknown', ageMs: null });
      expect(codes(body)).toContain('tick_unknown');
    });

    test('the thresholds are configurable', async () => {
      const options = { deployment: { tickLateAfterMs: 5_000, tickStaleAfterMs: 10_000 } };
      const body = await deployment(open(options, { readiness: tickedAgo(7_000) }));
      expect(body.tick).toMatchObject({ state: 'late', lateAfterMs: 5_000, staleAfterMs: 10_000 });
    });
  });

  describe('schema', () => {
    const record = (version: number) =>
      f.t.fresh.sql.unsafe(
        `INSERT INTO qcloud_schema_migrations (version, applied_at, checksum) VALUES ($1, 0, 'test')`,
        [version]
      );

    test('a database ahead of the code is a warning, not an error', async () => {
      await record(LATEST_VERSION + 1);
      try {
        const body = await deployment(open({}, { readiness: tickedAgo(1_000) }));
        expect(body.schema).toEqual({
          current: LATEST_VERSION + 1,
          expected: LATEST_VERSION,
          state: 'ahead',
        });
        expect(body.warnings).toContainEqual(
          expect.objectContaining({ code: 'schema_ahead', severity: 'warning' })
        );
      } finally {
        await f.t.fresh.sql.unsafe(`DELETE FROM qcloud_schema_migrations WHERE version = $1`, [
          LATEST_VERSION + 1,
        ]);
      }
    });
  });

  describe('database', () => {
    test('a database that does not answer is failed, with no latency, and the page still loads', async () => {
      const readiness = fakeReadiness({
        database: async () => {
          throw new Error('connect ECONNREFUSED postgres://u:pw@db:5432/x');
        },
        tick: async () => null,
      });
      const body = await deployment(open({}, { readiness }));
      expect(body.database).toEqual({ state: 'failed', latencyMs: null });
      expect(body.warnings).toContainEqual(
        expect.objectContaining({ code: 'database_unreachable', severity: 'critical' })
      );
      expect(JSON.stringify(body)).not.toContain('postgres://');
    });

    test('a transport that failed is a critical warning', async () => {
      const body = await deployment(
        open({}, { readiness: fakeReadiness({ transport: () => 'failed' }) })
      );
      expect(body.transport.state).toBe('failed');
      expect(codes(body)).toContain('transport_unreachable');
    });

    test('a transport never used is unknown and warns of nothing', async () => {
      const body = await deployment(
        open({}, { readiness: { ...tickedAgo(1_000), transport: () => 'unknown' } })
      );
      expect(body.transport.state).toBe('unknown');
      expect(codes(body)).not.toContain('transport_unreachable');
    });
  });

  describe('connections', () => {
    test('counts what is in use against the database cap', async () => {
      const body = await deployment(open({}, { readiness: tickedAgo(1_000) }));
      expect(body.connections.inUse).toBeGreaterThanOrEqual(1);
      expect(body.connections.maxConnections).toBeGreaterThan(0);
      expect(body.connections).toMatchObject({ needed: null, mode: null });
    });

    test('sets a declared fleet against the budget of task 05', async () => {
      const fleet = { workers: 4, poolSize: 2 };
      const body = await deployment(
        open({ deployment: { fleet } }, { readiness: tickedAgo(1_000) })
      );
      expect(body.connections).toMatchObject({ needed: budget(fleet).direct, mode: 'direct' });
      expect(codes(body)).not.toContain('connection_budget_exceeded');
    });

    test('behind a pooler it needs the pooler size, not one per process', async () => {
      const fleet = { workers: 500, poolSize: 2, pooler: true, poolerPoolSize: 20 };
      const body = await deployment(
        open({ deployment: { fleet } }, { readiness: tickedAgo(1_000) })
      );
      expect(body.connections).toMatchObject({
        needed: budget({ workers: 500, poolSize: 2, poolerPoolSize: 20 }).pooled,
        mode: 'pooled',
      });
    });

    test('a fleet that needs more than the database allows is critical', async () => {
      const fleet = { workers: 100_000 };
      const body = await deployment(
        open({ deployment: { fleet } }, { readiness: tickedAgo(1_000) })
      );
      expect(body.warnings).toContainEqual(
        expect.objectContaining({ code: 'connection_budget_exceeded', severity: 'critical' })
      );
    });
  });

  describe('workers and doorbells', () => {
    test('counts the registered workers, and zero is a reading, not a gap', async () => {
      const empty = await deployment(open({}, { readiness: tickedAgo(1_000) }));
      expect(empty.workers).toEqual({ total: 0, active: 0 });
      await f.store.workers.register({
        id: 'w1',
        queues: ['q'],
        name: 'one',
        hostname: 'h',
        pid: 1,
        concurrency: 1,
      });
      const one = await deployment(open({}, { readiness: tickedAgo(1_000) }));
      expect(one.workers).toEqual({ total: 1, active: 1 });
    });

    test('jobs with no bell are overdue doorbells, and old ones say the tick is behind', async () => {
      await enqueueN(f.store, 3, {}, 'a');
      await enqueueN(f.store, 2, {}, 'b');
      f.t.clock.advance(30_000);
      const young = await deployment(open({}, { readiness: tickedAgo(1_000) }));
      expect(young.doorbells).toEqual({
        notRung: 5,
        oldestNotRungAgeMs: 30_000,
        queuesScanned: 2,
        partial: false,
      });
      expect(codes(young)).not.toContain('doorbells_overdue');
      f.t.clock.advance(40_000);
      const old = await deployment(open({}, { readiness: tickedAgo(1_000) }));
      expect(old.doorbells.oldestNotRungAgeMs).toBe(70_000);
      expect(old.warnings).toContainEqual(
        expect.objectContaining({ code: 'doorbells_overdue', severity: 'warning' })
      );
    });

    test('jobs held by a pause or a closed run window are not an overdue doorbell', async () => {
      await enqueueN(f.store, 2, {}, 'a');
      await enqueueN(f.store, 3, {}, 'paused');
      await enqueueN(f.store, 4, {}, 'closed');
      await f.store.pause('paused');
      // The test clock reads 08:00 UTC, so a window that opened at 03:00 for an hour has closed.
      const hour = { cron: '0 3 * * *', durationMs: 3_600_000, timezone: 'UTC' };
      await f.store.queues.setRunWindow('closed', hour);
      f.t.clock.advance(70_000);
      const body = await deployment(open({}, { readiness: tickedAgo(1_000) }));
      expect(body.doorbells).toMatchObject({ notRung: 2, queuesScanned: 3 });
      expect(body.doorbells.oldestNotRungAgeMs).toBe(70_000);
    });

    test('says when it looked at some queues and not all of them', async () => {
      for (const queue of ['a', 'b', 'c']) await enqueueN(f.store, 1, {}, queue);
      const body = await deployment(
        open({ deployment: { maxQueues: 2 } }, { readiness: tickedAgo(1_000) })
      );
      expect(body.doorbells).toMatchObject({ queuesScanned: 2, partial: true });
    });
  });

  describe('timing', () => {
    const route = async (spec: Record<string, unknown>) => {
      const source =
        (await f.store.sources.list())[0] ?? (await f.store.sources.create({ name: 's' }, 't'));
      await f.store.webhooks.create(
        { url: 'https://hooks.example.com/in', source: source.id, ...spec },
        't'
      );
    };
    const nightly = { cron: '0 0 * * *', timezone: 'UTC' };
    const hour = { cron: '0 3 * * *', durationMs: 3_600_000, timezone: 'UTC' };

    test('a scheduled route and a closed window with no tick are named, and a running tick clears them', async () => {
      await route({ schedule: nightly });
      await enqueueN(f.store, 2, {}, 'closed');
      // The test clock reads 08:00 UTC, so a window that opened at 03:00 for an hour has closed.
      await f.store.queues.setRunWindow('closed', hour);
      const stopped = await deployment(open({}, { readiness: tickedAgo(null) }));
      expect(codes(stopped)).toEqual(
        expect.arrayContaining(['schedule_without_sender', 'window_without_tick'])
      );
      const running = await deployment(open({}, { readiness: tickedAgo(1_000) }));
      expect(codes(running)).not.toContain('schedule_without_sender');
      expect(codes(running)).not.toContain('window_without_tick');
    });

    test('a short delay is named only once the tick period is declared, and a disabled route is not counted', async () => {
      await route({ delayMs: 5_000 });
      await route({ delayMs: 5_000, enabled: false });
      await route({ delayMs: 90_000 });
      const declared = await deployment(
        open({ deployment: { tickIntervalMs: 60_000 } }, { readiness: tickedAgo(1_000) })
      );
      expect(only(declared, 'delay_finer_than_tick')).toEqual([
        expect.objectContaining({ message: expect.stringContaining('1 route(s)') }),
      ]);
      const silent = await deployment(open({}, { readiness: tickedAgo(1_000) }));
      expect(codes(silent)).not.toContain('delay_finer_than_tick');
    });
  });
});
