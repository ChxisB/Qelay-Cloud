import { afterAll, beforeAll, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { addTree, failFor, fanOut } from '../../store-postgres/test/flowHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';
import { keysFit, schema } from './openapiSpec';

// The same pin as the core groups' in `openapi.test.ts`, for the bodies the jobs and queues routes serve.
describeDb('docs/openapi.yaml jobs and queues bodies', () => {
  let f: JobsFixture;
  let api: JobsApi;
  let finished: string;
  let root: string;
  let failed: string;

  beforeAll(async () => {
    f = await openJobsFixture();
    api = f.api();
    const [done] = await f.store.enqueue([
      { queue: 'q', name: 'done', data: { n: 1 }, options: { jobId: 'finished' } },
    ]);
    finished = done!.id;
    const [lease] = await f.store.claim('q', 'worker', 1);
    await f.store.complete(lease!.lease, { answer: 42 });
    await f.store.enqueue([
      { queue: 'q', name: 'later', data: 'x', options: { delay: 60_000 } },
      { queue: 'q', name: 'now', data: 'y', options: { priority: 2, jobId: 'order-1' } },
    ]);
    const [parent] = await addTree(f.store, fanOut(2, { parentQueue: 'fp', childQueue: 'fk' }));
    root = parent!.id;
    failed = (await failFor(f.t, 'fk', 'broke')).id;
  });
  afterAll(() => f.drop());

  const fits = async (name: string, method: string, path: string, body?: unknown, key?: string) => {
    const answer = await api.call(method, path, body);
    expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
    const target = key === undefined ? answer.body : (answer.body as Record<string, any>)[key];
    expect(keysFit(target, name), `${method} ${path}`).toEqual([]);
    return answer.body as Record<string, any>;
  };

  test('jobs documents the dashboard and the statistics the store reads', async () => {
    await fits('Overview', 'GET', '/dashboard');
    await fits('Stats', 'GET', '/stats');
  });

  test('queues documents its counts, state, summary and pages', async () => {
    await fits('QueueCountsResponse', 'GET', '/queues/q/counts');
    await fits('QueuePausedResponse', 'GET', '/queues/q/paused');
    await fits('DashboardQueues', 'GET', '/dashboard/queues');
    const detail = await fits('QueueDetail', 'GET', '/dashboard/queues/q');
    expect(keysFit(detail.counts, 'QueueCounts')).toEqual([]);
    for (const summary of detail.jobs.waiting) expect(keysFit(summary, 'JobSummary')).toEqual([]);
    const rows = (await api.call<unknown[]>('GET', '/queues/summary')).body;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(keysFit(row, 'QueueSummaryRow')).toEqual([]);
  });

  test('jobs documents the list, the inspector page and each of its extra reads', async () => {
    const list = await fits('JobsList', 'GET', '/queues/q/jobs/list?limit=10');
    expect(list.jobs.length).toBeGreaterThan(0);
    for (const job of list.jobs) expect(keysFit(job, 'Job')).toEqual([]);
    const page = await fits('JobEnvelope', 'GET', `/jobs/${finished}`);
    expect(keysFit(page.job, 'Job')).toEqual([]);
    await fits('JobResult', 'GET', `/jobs/${finished}/result`);
    await fits('JobLogs', 'GET', `/jobs/${finished}/logs`);
    await fits('JobChildren', 'GET', `/jobs/${finished}/children`);
    await fits('JobEnvelope', 'GET', '/jobs/custom/order-1');
  });

  test('flows documents the list, the tree and what an action answers', async () => {
    const list = await fits('FlowList', 'GET', '/flows');
    expect(list.flows.length).toBeGreaterThan(0);
    for (const row of list.flows) expect(keysFit(row, 'FlowRoot')).toEqual([]);
    const view = await fits('FlowEnvelope', 'GET', `/flows/${root}`);
    expect(keysFit(view.flow, 'Flow')).toEqual([]);
    for (const node of view.flow.nodes) expect(keysFit(node, 'FlowNode')).toEqual([]);
    const version = view.flow.nodes.find((node: { id: string }) => node.id === failed).version;
    const done = await fits('FlowActionResult', 'POST', `/flows/${root}/actions`, {
      action: 'retry-failed',
      jobs: [{ id: failed, expectedVersion: version }],
    });
    expect(done.changes).toHaveLength(1);
    expect(Object.keys(done.changes[0]).sort()).toEqual(['from', 'id', 'queue', 'to']);
  });

  test('jobs documents what an add and an action answer', async () => {
    await fits('AddedJob', 'POST', '/queues/q/jobs', { data: 1 });
    await fits('AddedJobs', 'POST', '/queues/q/jobs/bulk', { jobs: [{ data: 1 }, { data: 2 }] });
    await fits('Ok', 'POST', `/jobs/${finished}/logs`, { message: 'hello', level: 'warn' });
    await fits('LogsCleared', 'DELETE', `/jobs/${finished}/logs`);
    await fits('Ok', 'PUT', '/jobs/order-1/priority', { priority: 5 });
    await fits('Ok', 'POST', '/queues/q/pause');
    await fits('Ok', 'POST', '/queues/q/resume');
    await fits('ActionCount', 'POST', '/queues/q/clean', { confirm: 'q', state: 'completed' });
    await fits('ActionCount', 'POST', '/queues/q/drain', { confirm: 'q' });
  });

  test('jobs request schemas name the fields the routes accept', () => {
    // A body the route takes and the spec does not name would be a client that cannot send it.
    const expected: Record<string, string[]> = {
      AddJobBody: [
        'name',
        'data',
        'priority',
        'delay',
        'maxAttempts',
        'backoff',
        'jobId',
        'uniqueKey',
      ],
      DataBody: ['data', 'expectedVersion'],
      PriorityBody: ['priority', 'lifo', 'expectedVersion'],
      DelayBody: ['delay', 'expectedVersion'],
      CleanBody: ['confirm', 'grace', 'state', 'limit'],
      ObliterateBody: ['confirm', 'force'],
      RateLimitBody: ['limit', 'duration', 'ttl'],
      ConcurrencyBody: ['concurrency'],
      FlowActionBody: ['action', 'jobs', 'parent', 'confirm'],
    };
    for (const [name, fields] of Object.entries(expected)) {
      expect(Object.keys(schema(name).properties ?? {}), name).toEqual(
        expect.arrayContaining(fields)
      );
    }
  });
});
