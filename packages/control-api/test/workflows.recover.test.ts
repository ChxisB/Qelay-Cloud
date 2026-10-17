import { expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { seedRun, stepJobs, useWorkflowApi } from './workflowFixture';

const IDLE_MS = 300_000;

describeDb('workflow action route: recover, rollbacks and bad bodies', () => {
  const w = useWorkflowApi();
  const { act, version, stateOf, parked } = w;
  const f = w.fixture;

  test('recover waits for the run to go quiet, then publishes its node again', async () => {
    await seedRun(f, 'w1', { currentNodeIndex: 3 });
    const early = await act('w1', { action: 'recover', expectedVersion: await version('w1') });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatchObject({
      code: 'workflow_progressing',
      details: { idleMs: IDLE_MS, idleForMs: 0 },
    });

    f.t.clock.advance(IDLE_MS);
    const v = await version('w1');
    const answer = await act('w1', { action: 'recover', expectedVersion: v });
    expect(answer).toMatchObject({ status: 200, body: { published: true, version: v + 1 } });
    expect(await stepJobs(f)).toEqual([{ executionId: 'w1', workflowName: 'order', nodeIndex: 3 }]);
    // It was written, so it is not idle again until another window has passed.
    const again = await act('w1', { action: 'recover', expectedVersion: v + 1 });
    expect(again.body.error.code).toBe('workflow_progressing');
  });

  test('recover drives an owed rollback again, for a failed run and a compensating one', async () => {
    await seedRun(f, 'failed', { state: 'failed', failureReason: 'boom' });
    await seedRun(f, 'busy', { state: 'compensating', failureReason: 'boom' });
    f.t.clock.advance(IDLE_MS);
    for (const id of ['failed', 'busy']) {
      const answer = await act(id, { action: 'recover', expectedVersion: await version(id) });
      expect(answer.status).toBe(200);
    }
    const jobs = await stepJobs(f);
    expect(jobs.map((job) => [job.executionId, job.recover]).sort()).toEqual([
      ['busy', true],
      ['failed', true],
    ]);
    expect(await stateOf('failed')).toBe('failed');
  });

  test('a parked run whose signal is recorded but never resumed is recovered at once, and one that awaits is not', async () => {
    await parked('lost');
    await parked('waiting');
    const lost = await f.store.workflows.recordSignal('lost', 'approved', { ok: true });
    expect(lost.resumed).toBe(true);
    await f.store.workflows.restoreSignalWait('lost', 'approved', lost.currentNodeIndex);
    expect(await stateOf('lost')).toBe('waiting');

    const refused = await act('waiting', {
      action: 'recover',
      expectedVersion: await version('waiting'),
    });
    expect(refused.body.error).toMatchObject({
      code: 'execution_state',
      details: { allowed: ['signal', 'cancel'] },
    });
    const answer = await act('lost', { action: 'recover', expectedVersion: await version('lost') });
    expect(answer.status).toBe(200);
    expect(await stateOf('lost')).toBe('running');
    expect(await stepJobs(f)).toEqual([
      { executionId: 'lost', workflowName: 'order', nodeIndex: 1 },
    ]);
  });

  test('retry and abandon hand a stuck rollback to a worker without touching the run', async () => {
    await seedRun(f, 'w1', { state: 'compensation-stuck', currentNodeIndex: 4 });
    const v = await version('w1');
    const unconfirmed = await act('w1', { action: 'abandon-compensation', expectedVersion: v });
    expect(unconfirmed.body.error.code).toBe('confirmation_required');
    expect(await stepJobs(f)).toEqual([]);

    expect(
      (await act('w1', { action: 'retry-compensation', expectedVersion: v })).body
    ).toMatchObject({ published: true, version: null });
    expect(
      (await act('w1', { action: 'abandon-compensation', expectedVersion: v, confirm: 'w1' }))
        .status
    ).toBe(200);
    expect(await stepJobs(f)).toEqual([
      { executionId: 'w1', workflowName: 'order', nodeIndex: 4, operator: 'retry-compensation' },
      { executionId: 'w1', workflowName: 'order', nodeIndex: 4, operator: 'abandon-compensation' },
    ]);
    expect(await version('w1')).toBe(v);
  });

  test('retry and abandon read the version too: a stale one is 409 and no job goes out', async () => {
    await seedRun(f, 'w1', { state: 'compensation-stuck', currentNodeIndex: 4 });
    const v = await version('w1');
    for (const body of [
      { action: 'retry-compensation' },
      { action: 'abandon-compensation', confirm: 'w1' },
    ]) {
      const answer = await act('w1', { ...body, expectedVersion: v + 1 });
      expect(answer.status).toBe(409);
      expect(answer.body.error).toMatchObject({
        code: 'version_conflict',
        details: { expectedVersion: v + 1, actualVersion: v },
      });
    }
    expect(await stepJobs(f)).toEqual([]);
    expect(await version('w1')).toBe(v);
  });

  test('a body with a misplaced or misspelt field is refused before anything is read', async () => {
    await seedRun(f, 'w1');
    const v = await version('w1');
    const bad: Array<Record<string, unknown>> = [
      { action: 'cancel', expectedVersion: v, confirm: 'w1', event: 'x' },
      { action: 'recover', expectedVersion: v, reason: 'because' },
      { action: 'signal', expectedVersion: v },
      { action: 'signal', expectedVersion: v, event: '__proto__' },
      { action: 'recover', expected_version: v },
      { action: 'recover' },
      { action: 'pause', expectedVersion: v },
    ];
    for (const body of bad) {
      const answer = await act('w1', body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
    }
    expect((await act('nope', { action: 'recover', expectedVersion: 0 })).status).toBe(404);
    expect(await version('w1')).toBe(v);
  });
});
