import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { seedFlow } from '../../store-postgres/test/flowActionHelpers';
import { addTree, failFor, fanOut, finish } from '../../store-postgres/test/flowHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

describeDb('flow read routes', () => {
  let f: JobsFixture;
  let api: JobsApi;
  beforeAll(async () => {
    f = await openJobsFixture();
  });
  afterAll(() => f.drop());
  beforeEach(async () => {
    await f.reset();
    api = f.api();
  });

  test('capabilities turn flows on where the jobs routes are served', async () => {
    const answer = await api.call('GET', '/capabilities');
    expect(answer.body.features.flows).toBe(true);
    expect(answer.body.unsupported).not.toContain('flows');
  });

  test('an empty namespace has an empty page of flows', async () => {
    const answer = await api.call('GET', '/flows');
    expect(answer).toMatchObject({
      status: 200,
      body: { ok: true, flows: [], total: 0, offset: 0 },
    });
  });

  test('the list shows each flow with its jobs by state and the failed children that hold it', async () => {
    const [stuck] = await addTree(f.store, fanOut(3, { parentQueue: 'a', childQueue: 'a-kids' }));
    await failFor(f.t, 'a-kids');
    await finish(f.t, 'a-kids');
    f.t.clock.advance(1_000);
    const [fresh] = await addTree(f.store, fanOut(1, { parentQueue: 'b', childQueue: 'b-kids' }));
    await f.store.enqueue([{ queue: 'plain', data: 1 }]);

    const answer = await api.call('GET', '/flows');
    expect(answer.status).toBe(200);
    const flows = answer.body.flows as Array<Record<string, any>>;
    // Newest first, and the plain job is not a flow.
    expect(flows.map((flow) => flow.id)).toEqual([fresh!.id, stuck!.id]);
    expect(answer.body.total).toBe(2);
    expect(flows[1]).toMatchObject({
      id: stuck!.id,
      queue: 'a',
      state: 'waiting-children',
      total: 4,
      states: { 'waiting-children': 1, failed: 1, completed: 1, waiting: 1 },
      blocked: 1,
    });
    expect(flows[0]).toMatchObject({ blocked: 0, total: 2 });
  });

  test('the list is paged, and a viewer may read it', async () => {
    for (let flow = 0; flow < 3; flow += 1) {
      await addTree(f.store, fanOut(1, { parentQueue: `p${flow}`, childQueue: `c${flow}` }));
      f.t.clock.advance(10);
    }
    const first = await api.call('GET', '/flows?limit=2');
    expect(first.body).toMatchObject({ total: 3, limit: 2, offset: 0 });
    expect(first.body.flows).toHaveLength(2);
    const second = await api.asViewer('GET', '/flows?limit=2&offset=2');
    expect(second.status).toBe(200);
    expect(second.body.flows).toHaveLength(1);
    expect((await api.call('GET', '/flows?limit=0')).status).toBe(400);
    expect((await api.call('GET', '/flows?offset=99999999')).body.error.code).toBe(
      'offset_too_large'
    );
  });

  test('one flow lists its jobs top level first, with versions, errors and the policy of each edge', async () => {
    const [root, first, second] = await addTree(f.store, {
      queue: 'top',
      data: 0,
      children: [
        { queue: 'kids', data: 1 },
        { queue: 'kids', data: 2, options: { continueParentOnFailure: true } },
      ],
    });
    await failFor(f.t, 'kids', 'cannot do it');
    const answer = await api.call('GET', `/flows/${root!.id}`);
    expect(answer.status).toBe(200);
    const flow = answer.body.flow;
    expect(flow).toMatchObject({ root: root!.id, total: 3, truncated: false });
    const nodes = flow.nodes as Array<Record<string, any>>;
    expect(nodes[0]).toMatchObject({
      id: root!.id,
      depth: 0,
      parentId: null,
      state: 'waiting-children',
    });
    const failed = nodes.find((node) => node.state === 'failed')!;
    expect([first!.id, second!.id]).toContain(failed.id);
    expect(failed).toMatchObject({ depth: 1, parentId: root!.id, error: 'cannot do it' });
    for (const node of nodes) expect(Number.isInteger(node.version)).toBe(true);
    expect(await api.asViewer('GET', `/flows/${root!.id}`)).toMatchObject({ status: 200 });
  });

  test('a job that is not the root of a flow, and a job that does not exist, are not flows', async () => {
    const [, child] = await addTree(f.store, fanOut(1));
    const [plain] = await f.store.enqueue([{ queue: 'plain', data: 1 }]);
    for (const id of [child!.id, plain!.id, 'nobody']) {
      const answer = await api.call('GET', `/flows/${id}`);
      expect(answer.status).toBe(404);
      expect(answer.body.error.code).toBe('flow_not_found');
    }
  });

  test('a flow bigger than the limit is cut, and says so', async () => {
    await seedFlow(f.t, 'big', 60);
    const answer = await api.call('GET', '/flows/big?limit=25');
    expect(answer.body.flow).toMatchObject({ total: 60, truncated: true, limit: 25 });
    expect(answer.body.flow.nodes).toHaveLength(25);
    expect((await api.call('GET', '/flows/big?limit=0')).status).toBe(400);
    expect((await api.call('GET', '/flows/big?limit=5001')).status).toBe(400);
    const whole = await api.call('GET', '/flows/big');
    expect(whole.body.flow).toMatchObject({ total: 60, truncated: false, limit: 1_000 });
  });

  test('the job inspector links a job to its parent, its children and its flow', async () => {
    const [root, first] = await addTree(f.store, fanOut(2));
    const parent = (await api.call('GET', `/jobs/${root!.id}`)).body.job;
    expect(parent.parentId).toBeNull();
    expect(parent.flowRoot).toBe(root!.id);
    expect(parent.childrenIds).toHaveLength(2);
    expect(parent.childrenIds).toContain(first!.id);
    const child = (await api.call('GET', `/jobs/${first!.id}`)).body.job;
    expect(child).toMatchObject({ parentId: root!.id, flowRoot: root!.id, childrenIds: [] });
    // A list does not read the children of each row.
    const listed = (await api.call('GET', '/queues/parents/jobs/list')).body.jobs[0];
    expect(listed).toMatchObject({ id: root!.id, parentId: null, childrenIds: [] });
    const plain = (await f.store.enqueue([{ queue: 'plain', data: 1 }]))[0]!;
    expect((await api.call('GET', `/jobs/${plain.id}`)).body.job).toMatchObject({
      parentId: null,
      flowRoot: null,
      childrenIds: [],
    });
  });

  test('the children of a parent are what its completed children returned', async () => {
    const [root] = await addTree(f.store, fanOut(2));
    const one = await finish(f.t, 'children', { n: 1 });
    await finish(f.t, 'children', 'two');
    const answer = await api.call('GET', `/jobs/${root!.id}/children`);
    expect(answer.status).toBe(200);
    expect(Object.keys(answer.body.data.values)).toHaveLength(2);
    expect(answer.body.data.values[`children:${one.id}`]).toEqual({ n: 1 });
    expect(answer.body.truncated).toBeUndefined();
  });
});
