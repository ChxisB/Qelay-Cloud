import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { SdkFixture } from './support';
import { openFixture, resetFixture } from './support';
import { until, workerKit } from './workerSupport';

describeDb('flow producer: running a flow', () => {
  let f: SdkFixture;
  const kit = workerKit(() => f);
  beforeAll(async () => {
    f = await openFixture();
  });
  afterAll(async () => {
    await f.drop();
  });
  beforeEach(async () => {
    await resetFixture(f);
  });
  afterEach(async () => {
    await kit.closeAll();
  });

  const finished = (state: string) => async (job: { getState(): Promise<string> }) =>
    (await job.getState()) === state;

  test('the parent runs after its children and its processor reads what they returned', async () => {
    const seen: Array<{ values: unknown; processed: string[]; unprocessed: string[] }> = [];
    kit.worker<number, number>('fetch', (job) => job.data * 10);
    kit.worker('reports', async (job) => {
      const deps = await job.getDependencies();
      seen.push({
        values: await job.getChildrenValues(),
        processed: Object.keys(deps.processed).sort(),
        unprocessed: [...deps.unprocessed],
      });
      return 'done';
    });
    const tree = await f.producer().add({
      name: 'report',
      queueName: 'reports',
      children: [
        { name: 'fetch', queueName: 'fetch', data: 1 },
        { name: 'fetch', queueName: 'fetch', data: 2 },
      ],
    });
    await until('the parent to complete', () => finished('completed')(tree.job));
    const [one, two] = tree.children!.map((node) => `fetch:${node.job.id}`);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      values: { [one!]: 10, [two!]: 20 },
      processed: [one, two].sort(),
      unprocessed: [],
    });
    // The same reads from the job as the producer's caller holds it, after the fact.
    const parent = (await f.queue('reports').getJob(tree.job.id))!;
    expect(await parent.getChildrenValues()).toEqual({ [one!]: 10, [two!]: 20 });
    expect(parent.returnvalue).toBe('done');
  });

  test('a parent two levels up waits for the middle job, which waits for its own children', async () => {
    const order: string[] = [];
    const record = (job: { name: string }) => void order.push(job.name);
    kit.worker('q', record);
    const tree = await f.producer().add({
      name: 'top',
      queueName: 'q',
      children: [
        {
          name: 'middle',
          queueName: 'q',
          children: [
            { name: 'leaf-a', queueName: 'q' },
            { name: 'leaf-b', queueName: 'q' },
          ],
        },
        { name: 'side', queueName: 'q' },
      ],
    });
    await until('the root to complete', () => finished('completed')(tree.job));
    expect(order.slice(-2)).toEqual(['middle', 'top']);
    expect(order.sort()).toEqual(['leaf-a', 'leaf-b', 'middle', 'side', 'top']);
  });

  test('failParentOnFailure fails the parent with the child error and it never runs', async () => {
    const ran: string[] = [];
    kit.worker('c', () => {
      throw new Error('boom');
    });
    kit.worker('p', (job) => void ran.push(job.name));
    const tree = await f.producer().add({
      name: 'parent',
      queueName: 'p',
      children: [
        { name: 'child', queueName: 'c', opts: { attempts: 1, failParentOnFailure: true } },
      ],
    });
    await until('the parent to fail', () => finished('failed')(tree.job));
    const failed = (await f.queue('p').getJob(tree.job.id))!;
    expect(failed.failedReason).toBe(`Child job ${tree.children![0]!.job.id} failed: boom`);
    await Bun.sleep(300);
    expect(ran).toEqual([]);
  });

  test('continueParentOnFailure and ignoreDependencyOnFailure record the failure for the parent to read', async () => {
    const seen: Array<{ failed: unknown; ignored: unknown; values: unknown }> = [];
    kit.worker('c', (job) => {
      if (job.name !== 'good') throw new Error(`${job.name} broke`);
      return 'fine';
    });
    kit.worker('p', async (job) => {
      seen.push({
        failed: await job.getFailedChildrenValues(),
        ignored: await job.getIgnoredChildrenFailures(),
        values: await job.getChildrenValues(),
      });
    });
    const tree = await f.producer().add({
      name: 'parent',
      queueName: 'p',
      children: [
        { name: 'good', queueName: 'c' },
        { name: 'ignored', queueName: 'c', opts: { attempts: 1, ignoreDependencyOnFailure: true } },
        { name: 'continued', queueName: 'c', opts: { attempts: 1, continueParentOnFailure: true } },
      ],
    });
    await until('the parent to complete', () => finished('completed')(tree.job));
    const [good, ignored, continued] = tree.children!.map((node) => node.job.id);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ignored).toEqual({ [`c:${ignored}`]: 'ignored broke' });
    expect(seen[0]!.failed).toEqual({ [`c:${continued}`]: 'continued broke' });
    // `continue` releases the parent at once: the good child may or may not have finished by then.
    expect(Object.keys(seen[0]!.values as object).every((key) => key === `c:${good}`)).toBe(true);
  });

  test('the reads of a job that has no children, or a child that has no failures, are empty', async () => {
    const queue = f.queue('plain');
    const job = await queue.add('x', {});
    expect(await job.getChildrenValues()).toEqual({});
    expect(await job.getDependencies()).toEqual({ processed: {}, unprocessed: [] });
    expect(await job.getFailedChildrenValues()).toEqual({});
    expect(await job.getIgnoredChildrenFailures()).toEqual({});
  });

  test('getFlow reads the flow as it is, to the depth and width asked for', async () => {
    const flows = f.producer();
    const tree = await flows.add({
      name: 'root',
      queueName: 'a',
      children: [
        {
          name: 'mid',
          queueName: 'b',
          children: [
            { name: 'l1', queueName: 'c' },
            { name: 'l2', queueName: 'c' },
          ],
        },
        { name: 'side', queueName: 'b' },
        { name: 'side', queueName: 'b' },
      ],
    });
    const whole = (await flows.getFlow({ id: tree.job.id, queueName: 'a' }))!;
    const names = (node: { job: { name: string }; children?: readonly unknown[] }): string[] => [
      node.job.name,
      ...((node.children ?? []) as Array<Parameters<typeof names>[0]>).flatMap(names),
    ];
    expect(names(whole).sort()).toEqual(['l1', 'l2', 'mid', 'root', 'side', 'side']);
    expect(whole.job).toMatchObject({ id: tree.job.id, queueName: 'a', duplicated: false });
    expect(
      (await flows.getFlow({ id: tree.job.id, queueName: 'a', depth: 0 }))!.children
    ).toBeUndefined();
    expect(
      names((await flows.getFlow({ id: tree.job.id, queueName: 'a', depth: 1 }))!)
    ).toHaveLength(4);
    const narrow = (await flows.getFlow({ id: tree.job.id, queueName: 'a', maxChildren: 1 }))!;
    expect(names(narrow)).toHaveLength(3);
    // A job in another queue, or none at all, is no flow of that name.
    expect(await flows.getFlow({ id: tree.job.id, queueName: 'wrong' })).toBeNull();
    expect(await flows.getFlow({ id: 'nobody', queueName: 'a' })).toBeNull();
    await expect(flows.getFlow({ id: tree.job.id, queueName: 'a', depth: -1 })).rejects.toThrow(
      RangeError
    );
  });

  test('getFlow leaves out a child that was removed when it completed', async () => {
    const flows = f.producer();
    kit.worker('b', () => 'ok');
    const tree = await flows.add({
      name: 'root',
      queueName: 'a',
      children: [
        { name: 'gone', queueName: 'b', opts: { removeOnComplete: true } },
        { name: 'kept', queueName: 'b' },
      ],
    });
    await until('both children to finish', async () => {
      const counts = await f.queue('b').getJobCounts();
      return counts.completed === 1 && counts.waiting === 0 && counts.active === 0;
    });
    const flow = (await flows.getFlow({ id: tree.job.id, queueName: 'a' }))!;
    expect(flow.children!.map((node) => node.job.name)).toEqual(['kept']);
  });
});
