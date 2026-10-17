import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import {
  addTree,
  failFor,
  fanOut,
  finish,
  flowDefects,
  summary,
} from '../../store-postgres/test/flowHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

interface Seen {
  readonly id: string;
  readonly expectedVersion: number;
}

describeDb('flow action route', () => {
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

  /** The versions a fresh read of the flow shows, for `ids`, as the panel would send them. */
  async function seen(root: string, ids: readonly string[]): Promise<Seen[]> {
    const nodes = (await api.call('GET', `/flows/${root}`)).body.flow.nodes as Array<
      Record<string, any>
    >;
    return ids.map((id) => ({
      id,
      expectedVersion: nodes.find((node) => node.id === id)!.version,
    }));
  }

  const act = async (root: string, body: Record<string, unknown>) =>
    api.call('POST', `/flows/${root}/actions`, body);

  const audited = async () => (await f.store.audit.list({ limit: 100 })).items;

  test('retrying a failed child queues it again, rings its bell and lets the parent complete', async () => {
    const [root] = await addTree(f.store, fanOut(2));
    const failed = await failFor(f.t, 'children', 'flaky');
    await finish(f.t, 'children');
    expect(f.transport.buffered('children').ready).toBe(0);

    const answer = await act(root!.id, {
      action: 'retry-failed',
      jobs: await seen(root!.id, [failed.id]),
    });
    expect(answer).toMatchObject({
      status: 200,
      body: {
        ok: true,
        action: 'retry-failed',
        changes: [{ id: failed.id, queue: 'children', from: 'failed', to: 'waiting' }],
      },
    });
    expect(f.transport.buffered('children').ready).toBe(1);
    expect((await summary(f.t, root!.id))!.state).toBe('waiting-children');

    await finish(f.t, 'children', 'second time lucky');
    expect((await summary(f.t, root!.id))!.state).toBe('waiting');
    expect(await flowDefects(f.t)).toEqual([]);
  });

  test('promoting a stuck parent queues it and rings its bell', async () => {
    const [root] = await addTree(f.store, fanOut(1));
    const failed = await failFor(f.t, 'children', 'cannot be fixed');
    const answer = await act(root!.id, {
      action: 'promote',
      parent: root!.id,
      jobs: await seen(root!.id, [root!.id, failed.id]),
    });
    expect(answer).toMatchObject({
      status: 200,
      body: {
        action: 'promote',
        changes: [{ id: root!.id, from: 'waiting-children', to: 'waiting' }],
      },
    });
    expect(f.transport.buffered('parents').ready).toBe(1);
  });

  test('a removal needs the root id as confirmation, and then deletes every job of the flow', async () => {
    const [root] = await addTree(f.store, fanOut(2));
    const everyone = await seen(root!.id, [root!.id, ...(await childIds(root!.id))]);
    for (const confirm of [undefined, 'children', 'nobody']) {
      const refused = await act(root!.id, {
        action: 'remove',
        jobs: everyone,
        ...(confirm === undefined ? {} : { confirm }),
      });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('confirmation_required');
    }
    expect((await api.call('GET', `/flows/${root!.id}`)).status).toBe(200);

    const answer = await act(root!.id, { action: 'remove', jobs: everyone, confirm: root!.id });
    expect(answer.status).toBe(200);
    expect(answer.body.changes).toHaveLength(3);
    expect(answer.body.changes.every((change: any) => change.to === 'removed')).toBe(true);
    expect((await api.call('GET', `/flows/${root!.id}`)).status).toBe(404);
    expect((await api.call('GET', '/flows')).body.total).toBe(0);
  });

  async function childIds(root: string): Promise<string[]> {
    return (await api.call('GET', `/jobs/${root}`)).body.job.childrenIds;
  }

  test('a flow with a running job is refused whole and every job stays', async () => {
    const [root] = await addTree(f.store, fanOut(2));
    await f.store.claim('children', 'w', 1);
    const everyone = await seen(root!.id, [root!.id, ...(await childIds(root!.id))]);
    const answer = await act(root!.id, { action: 'remove', jobs: everyone, confirm: root!.id });
    expect(answer.status).toBe(409);
    expect(answer.body.error).toMatchObject({ code: 'flow_active', details: { count: 1 } });
    expect((await api.call('GET', `/flows/${root!.id}`)).body.flow.total).toBe(3);
  });

  test('a job that moved since it was read is 409 version_conflict and nothing changes', async () => {
    const [root] = await addTree(f.store, fanOut(2));
    const failed = await failFor(f.t, 'children');
    const stale = await seen(root!.id, [failed.id]);
    await f.t.fresh.sql`UPDATE qcloud_jobs SET version = version + 1 WHERE id = ${failed.id}`;
    const answer = await act(root!.id, { action: 'retry-failed', jobs: stale });
    expect(answer.status).toBe(409);
    expect(answer.body.error).toMatchObject({
      code: 'version_conflict',
      details: { jobId: failed.id, expectedVersion: stale[0]!.expectedVersion },
    });
    expect((await summary(f.t, failed.id))!.state).toBe('failed');
    // The same request goes through once it carries the version the job has now.
    const fresh = await act(root!.id, {
      action: 'retry-failed',
      jobs: await seen(root!.id, [failed.id]),
    });
    expect(fresh.status).toBe(200);
  });

  test('a flow that has jobs the request did not name is 409 flow_changed', async () => {
    const [root] = await addTree(f.store, fanOut(2));
    const one = await failFor(f.t, 'children');
    const two = await failFor(f.t, 'children');
    const answer = await act(root!.id, {
      action: 'promote',
      parent: root!.id,
      jobs: await seen(root!.id, [root!.id, one.id]),
    });
    expect(answer.status).toBe(409);
    expect(answer.body.error).toMatchObject({
      code: 'flow_changed',
      details: { reason: 'unseen', ids: [two.id] },
    });
    expect((await summary(f.t, root!.id))!.state).toBe('waiting-children');
  });

  test('an action that does not apply is refused with its own code', async () => {
    const [root, first] = await addTree(f.store, fanOut(2));
    // Nothing failed: a waiting job is not retryable.
    const notRetryable = await act(root!.id, {
      action: 'retry-failed',
      jobs: await seen(root!.id, [first!.id]),
    });
    expect(notRetryable.body.error.code).toBe('flow_not_retryable');
    // Nothing holds the parent, and a child has not finished.
    const failed = await failFor(f.t, 'children');
    const unfinished = await act(root!.id, {
      action: 'promote',
      parent: root!.id,
      jobs: await seen(root!.id, [root!.id, failed.id]),
    });
    expect(unfinished.body.error).toMatchObject({
      code: 'flow_not_stuck',
      details: { reason: 'children_unfinished' },
    });
    expect(
      (
        await act('nobody', {
          action: 'remove',
          jobs: [{ id: 'x', expectedVersion: 0 }],
          confirm: 'nobody',
        })
      ).body.error.code
    ).toBe('flow_not_found');
  });

  test('a body with a misspelt field, no jobs, or a parent on the wrong action is 400', async () => {
    const [root, first] = await addTree(f.store, fanOut(1));
    const jobs = await seen(root!.id, [first!.id]);
    const cases: Array<[string, Record<string, unknown>]> = [
      ['misspelt', { action: 'retry-failed', jobs, expectedversion: 1 }],
      ['no jobs', { action: 'retry-failed', jobs: [] }],
      ['no version', { action: 'retry-failed', jobs: [{ id: first!.id }] }],
      ['unknown action', { action: 'cancel', jobs }],
      ['promote without a parent', { action: 'promote', jobs }],
      ['a parent on a retry', { action: 'retry-failed', jobs, parent: root!.id }],
      ['the same job twice', { action: 'retry-failed', jobs: [...jobs, ...jobs] }],
    ];
    for (const [name, body] of cases) {
      const answer = await act(root!.id, body);
      expect(answer.status, name).toBe(400);
    }
    expect((await summary(f.t, first!.id))!.state).toBe('waiting');
  });

  test('a viewer cannot act, and the refusal is audited', async () => {
    const [root, first] = await addTree(f.store, fanOut(1));
    const answer = await api.asViewer('POST', `/flows/${root!.id}/actions`, {
      action: 'retry-failed',
      jobs: await seen(root!.id, [first!.id]),
    });
    expect(answer.status).toBe(403);
    expect((await audited())[0]).toMatchObject({
      action: 'POST /flows/:id/actions',
      outcome: 'rejected',
      status: 403,
    });
  });

  test('every flow mutation writes one audit entry that names the action, whatever the answer', async () => {
    const [root] = await addTree(f.store, fanOut(2));
    const failed = await failFor(f.t, 'children');
    await finish(f.t, 'children');
    const jobs = await seen(root!.id, [failed.id]);
    const calls: Array<[string, Record<string, unknown>, number]> = [
      ['retry-failed', { action: 'retry-failed', jobs }, 200],
      ['retry-failed', { action: 'retry-failed', jobs }, 409],
      ['remove', { action: 'remove', jobs }, 400],
    ];
    for (const [name, body, status] of calls) {
      const before = (await audited()).length;
      expect((await act(root!.id, body)).status).toBe(status);
      const rows = await audited();
      expect(rows).toHaveLength(before + 1);
      expect(rows[0]).toMatchObject({
        action: 'POST /flows/:id/actions',
        target: `id=${root!.id} flowAction=${name}`,
        status,
        outcome: status === 200 ? 'success' : 'rejected',
      });
      expect(rows[0]!.finishedAt).not.toBeNull();
    }
  });
});
