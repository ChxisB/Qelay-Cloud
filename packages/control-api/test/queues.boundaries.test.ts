import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { MemoryTransport } from '@qelay-cloud/transport-local';
import { ManualClock } from '../../../test/support/clock';
import { describeDb } from '../../../test/support/db';
import { enqueueN } from '../../store-postgres/test/storeHelpers';
import type { JobsContext } from '../src/jobs/context';
import { cleanQueue, drainQueue, obliterateQueue } from '../src/jobs/queueActions';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';
import { harness } from './support';

describeDb('queues and jobs of two namespaces on one database', () => {
  let f: JobsFixture;
  let mine: JobsApi;
  let theirs: ReturnType<typeof harness>;
  beforeAll(async () => {
    f = await openJobsFixture();
  });
  afterAll(() => f.drop());
  beforeEach(async () => {
    await f.reset();
    mine = f.api({ summaryCacheMs: 2_000 });
    const other = f.t.another({ namespace: 'other' });
    theirs = harness(
      {},
      {
        jobs: {
          store: other,
          transport: new MemoryTransport({ clock: f.t.clock }),
          options: { summaryCacheMs: 2_000 },
        },
      },
      f.t.clock
    );
    await enqueueN(f.store, 2, {}, 'shared-name');
    await enqueueN(other, 5, {}, 'shared-name');
    await enqueueN(other, 1, {}, 'theirs-only');
    await other.enqueue([{ queue: 'shared-name', data: 'x', options: { jobId: 'their-custom' } }]);
  });

  const read = async (path: string) => {
    const response = await theirs.call('GET', path);
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };

  test('queues summary and counts show only the namespace of the store behind the API', async () => {
    const summary = await mine.call<{ name: string; counts: { waiting: number } }[]>(
      'GET',
      '/queues/summary'
    );
    expect(summary.body.map((queue) => [queue.name, queue.counts.waiting])).toEqual([
      ['shared-name', 2],
    ]);
    expect((await mine.call('GET', '/queues/theirs-only/counts')).body.counts.waiting).toBe(0);
    const other = await read('/queues/summary');
    expect(other.body.map((queue: { name: string }) => queue.name)).toEqual([
      'shared-name',
      'theirs-only',
    ]);
    expect((await read('/queues/shared-name/counts')).body.counts.waiting).toBe(6);
  });

  test('queues dashboard totals are per namespace, and the cache is not shared between them', async () => {
    expect((await mine.call('GET', '/dashboard')).body.stats.waiting).toBe(2);
    expect((await read('/dashboard')).body.stats.waiting).toBe(7);
    expect((await mine.call('GET', '/dashboard')).body.stats.waiting).toBe(2);
    expect((await read('/dashboard/queues')).body.total).toBe(2);
    expect((await mine.call('GET', '/dashboard/queues')).body.total).toBe(1);
  });

  test('jobs of another namespace are not found by id, by custom id or by an action', async () => {
    expect((await mine.call('GET', '/jobs/their-custom')).status).toBe(404);
    expect((await mine.call('GET', '/jobs/custom/their-custom')).status).toBe(404);
    expect((await mine.call('PUT', '/jobs/their-custom/data', { data: 'mine now' })).status).toBe(
      404
    );
    expect((await mine.call('DELETE', '/jobs/their-custom')).status).toBe(404);
    expect((await mine.call('POST', '/jobs/their-custom/logs', { message: 'x' })).status).toBe(404);
    const theirJob = await read('/jobs/their-custom');
    expect(theirJob.body.job).toMatchObject({ data: 'x', version: 0 });
  });

  test('queues actions of one namespace leave a queue of the same name in the other', async () => {
    expect((await mine.call('POST', '/queues/shared-name/pause')).status).toBe(200);
    expect(
      (await mine.call('POST', '/queues/shared-name/drain', { confirm: 'shared-name' })).body
    ).toMatchObject({ count: 2, done: true });
    expect((await read('/queues/shared-name/paused')).body.paused).toBe(false);
    expect((await read('/queues/shared-name/counts')).body.counts.waiting).toBe(6);
    const jobs = await read('/queues/shared-name/jobs/list');
    expect(jobs.body.total).toBe(6);
    await mine.call('POST', '/queues/shared-name/obliterate', {
      confirm: 'shared-name',
      force: true,
    });
    expect((await read('/queues/shared-name/counts')).body.counts.waiting).toBe(6);
  });

  test('jobs added through one API land in its own namespace only', async () => {
    const added = await mine.call('POST', '/queues/shared-name/jobs', { data: 1 });
    expect(added.status).toBe(200);
    expect((await read(`/jobs/${added.body.id}`)).status).toBe(404);
    expect((await mine.call('GET', `/jobs/${added.body.id}`)).status).toBe(200);
  });
});

describeDb('queues unsupported surfaces', () => {
  let f: JobsFixture;
  beforeAll(async () => {
    f = await openJobsFixture();
  });
  afterAll(() => f.drop());

  const surfaces: [string, string][] = [
    ['/server/info', 'serverControl'],
    ['/server/config/reload', 'serverControl'],
    ['/database/stats', 'sqliteDatabase'],
    ['/backup/list', 's3Backup'],
    ['/fleet/nodes', 'fleet'],
    ['/queue-operations/overview', 'queueOperations'],
  ];

  test('queues routes of a TCP server, SQLite, S3 backup and a fleet answer 501 with the capability', async () => {
    const api = f.api();
    for (const [path, capability] of surfaces) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        const answer = await api.call(method, path, method === 'GET' ? undefined : {});
        expect(answer.status, `${method} ${path}`).toBe(501);
        expect(answer.body.error.code).toBe('not_supported');
        expect(answer.body.error.details.capability).toBe(capability);
      }
    }
  });

  test('queues capabilities lists the same names as hidden', async () => {
    const answer = await f.api().call('GET', '/capabilities');
    const hidden: string[] = answer.body.hidden ?? [];
    for (const capability of new Set(surfaces.map(([, name]) => name))) {
      expect(hidden).toContain(capability);
    }
  });

  test('queues unsupported surfaces still need a token', async () => {
    const api = f.api();
    const anonymous = await api.api.call('GET', '/server/info', { token: null });
    expect(anonymous.status).toBe(401);
  });
});

describe('queues action budget', () => {
  /** A context whose store takes `stepMs` of the manual clock for each batch, and always has more. */
  function endless(stepMs: number, budgetMs: number) {
    const clock = new ManualClock(1_000);
    const batch = async () => {
      clock.advance(stepMs);
      return { removed: ['a', 'b'], more: true };
    };
    const ctx = {
      clock,
      config: { actionBudgetMs: budgetMs },
      store: {
        control: {
          drain: batch,
          cleanPending: batch,
          obliterate: async () => {
            clock.advance(stepMs);
            return { removed: 2, done: false };
          },
        },
        maintenance: { clean: batch },
      },
    } as unknown as JobsContext;
    return ctx;
  }

  test('queues drain stops at the budget and says work is left', async () => {
    expect(await drainQueue(endless(400, 1_000), 'q')).toEqual({ count: 6, done: false });
  });

  test('queues clean stops at the budget, and its limit ends it as done', async () => {
    expect(await cleanQueue(endless(400, 1_000), 'q', { state: 'completed' })).toEqual({
      count: 6,
      done: false,
    });
    expect(await cleanQueue(endless(1, 1_000_000), 'q', { limit: 4 })).toEqual({
      count: 4,
      done: true,
    });
  });

  test('queues obliterate stops at the budget and a second call continues', async () => {
    expect(await obliterateQueue(endless(600, 1_000), 'q', false)).toEqual({
      count: 4,
      done: false,
    });
  });
});
