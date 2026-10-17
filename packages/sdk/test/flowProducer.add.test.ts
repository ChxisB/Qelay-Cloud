import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { FlowError, FlowProtectedError, MAX_FLOW_DEPTH, MAX_FLOW_JOBS } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { FlowJob } from '../src';
import type { SdkFixture } from './support';
import { openFixture, resetFixture, rungOf } from './support';

describeDb('flow producer: adding a flow', () => {
  let f: SdkFixture;
  beforeAll(async () => {
    f = await openFixture();
  });
  afterAll(async () => {
    await f.drop();
  });
  beforeEach(async () => {
    await resetFixture(f);
  });

  const jobCount = async (): Promise<number> => {
    const [row] = await f.fresh.sql<Array<{ n: string }>>`SELECT count(*) AS n FROM qcloud_jobs`;
    return Number(row!.n);
  };

  const report = (extra: Partial<FlowJob> = {}): FlowJob => ({
    name: 'report',
    queueName: 'reports',
    data: { n: 0 },
    children: [
      {
        name: 'fetch',
        queueName: 'fetch',
        data: 1,
        opts: { failParentOnFailure: true, attempts: 3 },
      },
      { name: 'fetch', queueName: 'fetch', data: 2, opts: { delay: 60_000 } },
      { name: 'merge', queueName: 'merge', children: [{ name: 'leaf', queueName: 'fetch' }] },
    ],
    ...extra,
  });

  test('add returns the jobs shaped like the input, the parents waiting for their children', async () => {
    const tree = await f.producer().add(report());
    expect(tree.job).toMatchObject({
      name: 'report',
      queueName: 'reports',
      data: { n: 0 },
      duplicated: false,
    });
    const [first, delayed, merge] = tree.children!;
    expect(first!.job).toMatchObject({ name: 'fetch', queueName: 'fetch', data: 1 });
    expect(first!.job.opts.attempts).toBe(3);
    // The failure flags are the flow's, not the job's options.
    expect('failParentOnFailure' in first!.job.opts).toBe(false);
    expect(first!.children).toBeUndefined();
    expect(merge!.children).toHaveLength(1);
    expect(merge!.children![0]!.job).toMatchObject({ name: 'leaf', queueName: 'fetch' });
    expect(await tree.job.getState()).toBe('waiting-children');
    expect(await merge!.job.getState()).toBe('waiting-children');
    expect(await first!.job.getState()).toBe('waiting');
    expect(await delayed!.job.getState()).toBe('delayed');
    expect(await merge!.children![0]!.job.getState()).toBe('waiting');
    expect(await jobCount()).toBe(5);
  });

  test('only the children that can be claimed now are rung; a parent never is', async () => {
    const tree = await f.producer().add(report());
    const [first, delayed, merge] = tree.children!;
    const leaf = merge!.children![0]!;
    const rung = await rungOf(f, [
      tree.job.id,
      first!.job.id,
      delayed!.job.id,
      merge!.job.id,
      leaf.job.id,
    ]);
    expect(rung).toEqual({
      [tree.job.id]: false,
      [first!.job.id]: true,
      // Its delay is far past what the memory transport holds, so it is left to the tick.
      [delayed!.job.id]: rung[delayed!.job.id]!,
      [merge!.job.id]: false,
      [leaf.job.id]: true,
    });
    expect(f.transport.buffered('fetch').ready).toBe(2);
    expect(f.transport.buffered('reports')).toMatchObject({ ready: 0, delayed: 0, inFlight: 0 });
    expect(f.transport.buffered('merge')).toMatchObject({ ready: 0, delayed: 0, inFlight: 0 });
  });

  test('a bell that cannot be rung does not fail the add: the jobs are there, unrung', async () => {
    f.transport.throwNext(1);
    const tree = await f.producer().add({
      name: 'p',
      queueName: 'a',
      children: [{ name: 'c', queueName: 'b' }],
    });
    expect(await rungOf(f, [tree.children![0]!.job.id])).toEqual({
      [tree.children![0]!.job.id]: false,
    });
    expect(await jobCount()).toBe(2);
  });

  test('adding the same flow twice, with a custom id on the root, makes one parent', async () => {
    const flows = f.producer();
    const first = await flows.add(report({ opts: { jobId: 'report-1' } }));
    expect(first.job.duplicated).toBe(false);
    const again = await flows.add(report({ opts: { jobId: 'report-1' } }));
    expect(again.job.id).toBe('report-1');
    expect(again.job.duplicated).toBe(true);
    expect(again.children!.map((node) => node.job.id).sort()).toEqual(
      first.children!.map((node) => node.job.id).sort()
    );
    expect(await jobCount()).toBe(5);
    const [edges] = await f.fresh.sql<
      Array<{ n: string }>
    >`SELECT count(*) AS n FROM qcloud_dependencies`;
    expect(Number(edges!.n)).toBe(4);
  });

  test('a custom id that another live job holds refuses the flow and writes nothing', async () => {
    await f.queue('fetch').add('taken', {}, { jobId: 'leaf-1' });
    const before = await jobCount();
    await expect(
      f.producer().add({
        name: 'p',
        queueName: 'reports',
        children: [{ name: 'c', queueName: 'fetch', opts: { jobId: 'leaf-1' } }],
      })
    ).rejects.toThrow(FlowError);
    expect(await jobCount()).toBe(before);
  });

  test('queuesOptions and the producer defaults sit under the options of each job', async () => {
    const flows = f.producer({ defaultJobOptions: { attempts: 2, backoff: 100 } });
    const tree = await flows.add(
      {
        name: 'p',
        queueName: 'reports',
        children: [
          { name: 'a', queueName: 'fetch' },
          { name: 'b', queueName: 'fetch', opts: { attempts: 9 } },
          { name: 'c', queueName: 'other' },
        ],
      },
      { queuesOptions: { fetch: { defaultJobOptions: { attempts: 5, priority: 3 } } } }
    );
    const [a, b, c] = tree.children!.map((node) => node.job);
    expect(tree.job.opts).toMatchObject({ attempts: 2, backoff: 100 });
    expect(a!.opts).toMatchObject({ attempts: 5, backoff: 100, priority: 3 });
    expect(a!.priority).toBe(3);
    expect(b!.opts).toMatchObject({ attempts: 9, priority: 3 });
    expect(c!.opts).toMatchObject({ attempts: 2 });
    // What was stored is what the jobs say they are.
    const stored = await f.queue('fetch').getJob(a!.id);
    expect(stored!.opts).toMatchObject({ attempts: 5, priority: 3 });
  });

  test('addBulk adds each flow in order and returns their nodes in order', async () => {
    const nodes = await f.producer().addBulk([
      { name: 'one', queueName: 'q', children: [{ name: 'c', queueName: 'q' }] },
      { name: 'two', queueName: 'q', children: [{ name: 'c', queueName: 'q' }] },
    ]);
    expect(nodes.map((node) => node.job.name)).toEqual(['one', 'two']);
    expect(await jobCount()).toBe(4);
    expect(await f.producer().addBulk([])).toEqual([]);
  });

  test('a malformed flow in addBulk rejects the call before anything is written', async () => {
    const loop: { name: string; queueName: string; children: FlowJob[] } = {
      name: 'x',
      queueName: 'q',
      children: [],
    };
    loop.children.push(loop);
    const bad: Array<[string, unknown, RegExp]> = [
      ['a cycle', loop, /more than once/],
      ['no name', { queueName: 'q' }, /needs a name/],
      ['no queue', { name: 'x' }, /queueName/],
      ['a colon in a custom id', { name: 'x', queueName: 'q', opts: { jobId: 'a:b' } }, /":"/],
      [
        'a policy on the root',
        { name: 'x', queueName: 'q', opts: { failParentOnFailure: true } },
        /root/,
      ],
      [
        'repeat',
        {
          name: 'x',
          queueName: 'q',
          children: [{ name: 'c', queueName: 'q', opts: { repeat: { every: 1 } } }],
        },
        /repeat/,
      ],
      [
        'removeOnFail with no policy',
        {
          name: 'x',
          queueName: 'q',
          children: [{ name: 'c', queueName: 'q', opts: { removeOnFail: true } }],
        },
        /failure policy/,
      ],
      ['children that is not an array', { name: 'x', queueName: 'q', children: 'no' }, /array/],
    ];
    for (const [label, flow, message] of bad) {
      const error = await f
        .producer()
        .addBulk([
          { name: 'fine', queueName: 'q', children: [{ name: 'c', queueName: 'q' }] },
          flow as FlowJob,
        ])
        .catch((caught: unknown) => caught);
      expect(error, label).toBeInstanceOf(Error);
      expect((error as Error).message, label).toMatch(message);
      expect(await jobCount(), label).toBe(0);
    }
  });

  test('a flow is refused beyond its depth and size limits, before anything is written', async () => {
    let deep: FlowJob = { name: 'leaf', queueName: 'q' };
    for (let level = 1; level < MAX_FLOW_DEPTH + 1; level++) {
      deep = { name: 'n', queueName: 'q', children: [deep] };
    }
    await expect(f.producer().add(deep)).rejects.toThrow(/levels deep/);
    const wide: FlowJob = {
      name: 'root',
      queueName: 'q',
      children: Array.from({ length: MAX_FLOW_JOBS }, () => ({ name: 'c', queueName: 'q' })),
    };
    await expect(f.producer().add(wide)).rejects.toThrow(/at most 1000 jobs/);
    expect(await jobCount()).toBe(0);
    // The limits are inclusive: the deepest and the largest flow there can be are written.
    let deepest: FlowJob = { name: 'leaf', queueName: 'q' };
    for (let level = 1; level < MAX_FLOW_DEPTH; level++) {
      deepest = { name: 'n', queueName: 'q', children: [deepest] };
    }
    await f.producer().add(deepest);
    expect(await jobCount()).toBe(MAX_FLOW_DEPTH);
    await f.producer().add({ ...wide, children: wide.children!.slice(1) });
    expect(await jobCount()).toBe(MAX_FLOW_DEPTH + MAX_FLOW_JOBS);
  });

  test('a child that a parent waits on cannot be removed through its job', async () => {
    const tree = await f.producer().add({
      name: 'p',
      queueName: 'a',
      children: [{ name: 'c', queueName: 'b' }],
    });
    await expect(tree.children![0]!.job.remove()).rejects.toThrow(FlowProtectedError);
    expect(await tree.children![0]!.job.getState()).toBe('waiting');
  });

  test('a producer closes once and refuses nothing it already did', async () => {
    const flows = f.producer();
    await flows.waitUntilReady();
    await flows.add({ name: 'p', queueName: 'a', children: [{ name: 'c', queueName: 'b' }] });
    await flows.close({ timeout: 1000 });
    await flows.disconnect();
    expect(await jobCount()).toBe(2);
  });
});
