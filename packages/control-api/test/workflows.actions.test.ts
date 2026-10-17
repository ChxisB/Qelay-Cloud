import { expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { seedRun, stepJobs, useWorkflowApi } from './workflowFixture';

describeDb('workflow action route: cancel, versions and signals', () => {
  const w = useWorkflowApi();
  const { act, version, parked } = w;
  const f = w.fixture;

  test('cancel needs the run id as confirmation, and refusing it changes nothing', async () => {
    await seedRun(f, 'w1');
    const v = await version('w1');
    for (const confirm of [undefined, 'w2', '']) {
      const refused = await act('w1', {
        action: 'cancel',
        expectedVersion: v,
        ...(confirm === undefined ? {} : { confirm }),
      });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('confirmation_required');
    }
    expect(await version('w1')).toBe(v);
    expect(await stepJobs(f)).toEqual([]);
  });

  test('cancel claims the run as failed with the operator as the reason, then publishes its rollback', async () => {
    await seedRun(f, 'w1', { currentNodeIndex: 2 });
    const v = await version('w1');
    const answer = await act('w1', {
      action: 'cancel',
      expectedVersion: v,
      confirm: 'w1',
      reason: 'customer withdrew',
    });
    expect(answer).toMatchObject({
      status: 200,
      body: { ok: true, action: 'cancel', executionId: 'w1', published: true, version: v + 1 },
    });
    const run = (await f.store.workflows.get('w1'))!;
    expect(run).toMatchObject({
      state: 'failed',
      failureReason: 'Cancelled by an operator: customer withdrew',
      version: v + 1,
    });
    expect(run.rollbackStatus).toBeUndefined();
    expect(await stepJobs(f)).toEqual([
      { executionId: 'w1', workflowName: 'order', nodeIndex: 2, recover: true },
    ]);
  });

  test('a cancel without a reason says it was an operator', async () => {
    await parked();
    const answer = await act('w1', {
      action: 'cancel',
      expectedVersion: await version('w1'),
      confirm: 'w1',
    });
    expect(answer.status).toBe(200);
    expect((await f.store.workflows.get('w1'))!.failureReason).toBe('Cancelled by an operator');
  });

  test('an action on a run that moved since it was read is 409, and nothing changes', async () => {
    await seedRun(f, 'w1');
    const seen = await version('w1');
    const moved = (await f.store.workflows.get('w1'))!;
    moved.currentNodeIndex = 1;
    await f.store.workflows.update(moved);
    const before = await f.store.workflows.get('w1');

    for (const body of [
      { action: 'cancel', confirm: 'w1' },
      { action: 'signal', event: 'approved' },
      { action: 'recover' },
    ]) {
      const answer = await act('w1', { ...body, expectedVersion: seen });
      expect(answer.status).toBe(409);
      expect(answer.body.error).toMatchObject({
        code: 'version_conflict',
        details: { expectedVersion: seen, actualVersion: seen + 1 },
      });
    }
    expect(await f.store.workflows.get('w1')).toEqual(before!);
    expect(await stepJobs(f)).toEqual([]);
  });

  test('two operators acting on the same version: one wins, the other is refused and no second job goes out', async () => {
    await seedRun(f, 'w1');
    const body = { action: 'cancel', expectedVersion: await version('w1'), confirm: 'w1' };
    const answers = await Promise.all([act('w1', body), act('w1', body)]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    expect(answers.find((answer) => answer.status === 409)!.body.error.code).toBe(
      'version_conflict'
    );
    expect(await stepJobs(f)).toHaveLength(1);
  });

  test('a finished run is refused whatever the version, with the state it ended in', async () => {
    await seedRun(f, 'done', { state: 'completed' });
    await seedRun(f, 'undone', { state: 'failed', rollbackStatus: 'completed' });
    for (const id of ['done', 'undone']) {
      for (const stale of [0, 99]) {
        const answer = await act(id, {
          action: 'cancel',
          expectedVersion: stale,
          confirm: id,
        });
        expect(answer.status).toBe(409);
        expect(answer.body.error.code).toBe('execution_terminal');
      }
    }
    expect(
      (await act('done', { action: 'recover', expectedVersion: 0 })).body.error.details
    ).toEqual({ state: 'completed' });
    expect(await stepJobs(f)).toEqual([]);
  });

  test('an action that does not apply to the state says what does', async () => {
    await seedRun(f, 'w1');
    const answer = await act('w1', {
      action: 'retry-compensation',
      expectedVersion: await version('w1'),
    });
    expect(answer.status).toBe(409);
    expect(answer.body.error).toMatchObject({
      code: 'execution_state',
      details: { state: 'running', allowed: ['signal', 'cancel'] },
    });
    expect(await stepJobs(f)).toEqual([]);
  });

  test('a signal resumes a parked run and keeps its payload', async () => {
    await parked();
    const answer = await act('w1', {
      action: 'signal',
      expectedVersion: await version('w1'),
      event: 'approved',
      payload: { by: 'ops', big: { $type: 'bigint', value: '9007199254740993' } },
    });
    expect(answer).toMatchObject({
      status: 200,
      body: { action: 'signal', published: true, resumed: true, version: null },
    });
    const run = (await f.store.workflows.get('w1'))!;
    expect(run.state).toBe('running');
    expect(run.signals.approved).toEqual({ by: 'ops', big: 9007199254740993n });
    expect(await stepJobs(f)).toEqual([{ executionId: 'w1', workflowName: 'order', nodeIndex: 1 }]);
  });

  test('a signal into a run that is not parked is only recorded, and the same event twice is refused', async () => {
    await seedRun(f, 'w1');
    const body = { action: 'signal', event: 'approved', payload: 1 };
    const first = await act('w1', { ...body, expectedVersion: await version('w1') });
    expect(first).toMatchObject({ status: 200, body: { published: false, resumed: false } });
    expect((await f.store.workflows.get('w1'))!.signals).toEqual({ approved: 1 });
    expect(await stepJobs(f)).toEqual([]);

    const second = await act('w1', { ...body, expectedVersion: await version('w1') });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({
      code: 'signal_rejected',
      details: { reason: 'duplicate' },
    });
  });

  test('a signal is refused for a rollback in progress', async () => {
    await seedRun(f, 'w1', { state: 'compensating' });
    const answer = await act('w1', {
      action: 'signal',
      expectedVersion: await version('w1'),
      event: 'approved',
    });
    expect(answer.body.error.code).toBe('execution_state');
  });
});
