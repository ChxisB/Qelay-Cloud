import { expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { defineWorkflow } from '../src';
import { describeWorkflow } from '../src/workflow/definitionRecord';
import { untilState, useWorkflowKit } from './workflowSupport';

const approval = (name: string) =>
  defineWorkflow(name)
    .step('reserve', () => 1, { retry: 2, compensate: () => undefined })
    .waitFor('approved', { timeout: 60_000 })
    .step('ship', () => 2);

describeDb('workflow: definitions announced to the store', () => {
  const { kit, fixture } = useWorkflowKit();
  const stored = () => fixture().store.workflows;

  test('register announces the graph and the hash a run is bound to', async () => {
    const engine = kit.engine();
    await engine.register(approval('announced'));
    const run = await engine.start('announced', {});
    await untilState(engine, run.id, 'waiting');

    const [definition] = await stored().listDefinitions({ name: 'announced' });
    const exec = (await engine.getExecution(run.id))!;
    expect(definition?.hash).toBe(exec.definitionHash!);
    expect(definition?.graph.map((node) => node.type)).toEqual(['step', 'waitFor', 'step']);
    expect(definition?.graph[0]).toEqual({
      type: 'step',
      step: { name: 'reserve', retry: 2, timeout: expect.any(Number), compensates: true },
    });
    expect(definition?.graph[1]).toEqual({ type: 'waitFor', event: 'approved', timeout: 60_000 });
  });

  test('the description holds no handler and is the same for the same definition', () => {
    const a = describeWorkflow(approval('same'));
    const b = describeWorkflow(approval('same'));
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toContain('=>');
  });

  test('a refresh moves lastSeenAt forward', async () => {
    const engine = kit.engine({ announceMs: 50 });
    await engine.register(approval('refreshed'));
    const [first] = await stored().listDefinitions({ name: 'refreshed' });
    await Bun.sleep(300);
    const [later] = await stored().listDefinitions({ name: 'refreshed' });
    expect(later!.lastSeenAt).toBeGreaterThan(first!.lastSeenAt);
    expect(later!.firstSeenAt).toBe(first!.firstSeenAt);
  });

  test('announceMs 0 announces nothing', async () => {
    const engine = kit.engine({ announceMs: 0 });
    await engine.register(approval('silent'));
    expect(await stored().listDefinitions({ name: 'silent' })).toEqual([]);
  });

  test('a store that cannot take the announcement does not stop register or start', async () => {
    const f = fixture();
    const warnings: string[] = [];
    const logger = { warn: (message: string) => void warnings.push(message) };
    await f.fresh
      .sql`ALTER TABLE qcloud_workflow_definitions RENAME TO qcloud_workflow_definitions_away`;
    try {
      const engine = kit.engine({ logger });
      await engine.register(approval('unannounced'));
      const run = await engine.start('unannounced', {});
      await untilState(engine, run.id, 'waiting');
      expect(warnings).toContain('workflow definition could not be announced');
    } finally {
      await kit.closeAll();
      await f.fresh
        .sql`ALTER TABLE qcloud_workflow_definitions_away RENAME TO qcloud_workflow_definitions`;
    }
  });
});
