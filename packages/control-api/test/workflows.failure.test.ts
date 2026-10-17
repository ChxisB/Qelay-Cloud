import { expect, spyOn, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { seedRun, stepJobs, useWorkflowApi } from './workflowFixture';

const IDLE_MS = 300_000;

describeDb('workflow action route: failures, roles and audit', () => {
  const w = useWorkflowApi();
  const { act, version, stateOf, audited, parked } = w;
  const f = w.fixture;

  test('a failed publish after the claim says so, and the run stays for the tick to recover', async () => {
    await seedRun(f, 'w1');
    const spy = spyOn(f.store, 'enqueue').mockRejectedValueOnce(new Error('queue is down'));
    const v = await version('w1');
    const answer = await act('w1', { action: 'cancel', expectedVersion: v, confirm: 'w1' });
    spy.mockRestore();
    expect(answer.status).toBe(503);
    expect(answer.body.error).toMatchObject({ code: 'publish_failed', details: { claimed: true } });
    expect(JSON.stringify(answer.body)).not.toContain('queue is down');
    expect(await stateOf('w1')).toBe('failed');
    f.t.clock.advance(IDLE_MS);
    const retry = await act('w1', { action: 'recover', expectedVersion: await version('w1') });
    expect(retry.status).toBe(200);
    expect(await stepJobs(f)).toHaveLength(1);
  });

  test('a signal whose publish fails leaves the run parked with the signal recorded, and recover resumes it', async () => {
    await parked();
    const spy = spyOn(f.store, 'enqueue').mockRejectedValueOnce(new Error('queue is down'));
    const answer = await act('w1', {
      action: 'signal',
      expectedVersion: await version('w1'),
      event: 'approved',
    });
    spy.mockRestore();
    expect(answer.status).toBe(503);
    const run = (await f.store.workflows.get('w1'))!;
    expect(run.state).toBe('waiting');
    expect(Object.keys(run.signals)).toEqual(['approved']);
    const recovered = await act('w1', { action: 'recover', expectedVersion: run.version });
    expect(recovered.status).toBe(200);
    expect(await stateOf('w1')).toBe('running');
  });

  test('a viewer cannot act, and the refusal is audited without the body', async () => {
    await seedRun(f, 'w1');
    const v = await version('w1');
    const answer = await w.api.asViewer('POST', '/workflows/executions/w1/actions', {
      action: 'cancel',
      expectedVersion: v,
      confirm: 'w1',
    });
    expect(answer.status).toBe(403);
    expect(await version('w1')).toBe(v);
    expect((await audited())[0]).toMatchObject({
      action: 'POST /workflows/executions/:id/actions',
      outcome: 'rejected',
      status: 403,
    });
  });

  test('every action writes one audit entry that names the action and never a payload, an event or a reason', async () => {
    await parked();
    const secret = 'SECRET-PAYLOAD-7f3a';
    const calls: Array<[string, Record<string, unknown>, number]> = [
      [
        'signal',
        {
          action: 'signal',
          event: `ev-${secret}`,
          payload: { token: secret },
          expectedVersion: 99,
        },
        409,
      ],
      ['signal', { action: 'signal', event: 'approved', payload: { token: secret } }, 200],
      ['cancel', { action: 'cancel', confirm: 'w1', reason: secret, expectedVersion: 99 }, 409],
      ['recover', { action: 'recover' }, 409],
    ];
    for (const [name, body, status] of calls) {
      const before = (await audited()).length;
      const answer = await act('w1', { expectedVersion: await version('w1'), ...body });
      expect(answer.status, name).toBe(status);
      const rows = await audited();
      expect(rows).toHaveLength(before + 1);
      expect(rows[0]).toMatchObject({
        action: 'POST /workflows/executions/:id/actions',
        target: `id=w1 workflowAction=${name}`,
        status,
        outcome: status === 200 ? 'success' : 'rejected',
      });
    }
    expect(JSON.stringify(await audited())).not.toContain(secret);
  });
});
