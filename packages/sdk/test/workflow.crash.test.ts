import { afterEach, expect, test } from 'bun:test';
import type { Execution } from '@qelay-cloud/core';
import { describeDb, testDatabaseUrl } from '../../../test/support/db';
import type { WorkflowEvent } from '../src';
import { defineWorkflow } from '../src';
import { Lines } from './childLines';
import type { Probe } from './crashFlow';
import { forwardFlow, rollbackFlow } from './crashFlow';
import { NAMESPACE } from './support';
import { pause } from './workerSupport';
import { useWorkflowKit } from './workflowSupport';

const CHILD = `${import.meta.dir}/crashEngine.ts`;
const QUEUE = '__wf:crash';
/** The tick takes a run after this much silence; the child's heartbeat gap is 100 ms. */
const IDLE_MS = 600;

describeDb('workflow: a killed engine process', () => {
  const { kit, fixture } = useWorkflowKit();
  const children: Array<ReturnType<typeof Bun.spawn>> = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });

  /** A child that starts one run and dies at `plan`. Resolves with its lines and the run id. */
  async function crashAt(flow: 'forward' | 'rollback', plan: string) {
    const child = Bun.spawn(
      ['bun', CHILD, testDatabaseUrl(), fixture().fresh.name, NAMESPACE, QUEUE, flow, plan],
      { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' }
    );
    children.push(child);
    const lines = new Lines(child.stdout as ReadableStream<Uint8Array>);
    expect(await child.exited).not.toBe(0);
    await pause(100);
    const runLine = lines.all.find((line) => line.startsWith('RUN '));
    if (runLine === undefined)
      throw new Error(`the child died before its run started: ${lines.all}`);
    return { id: runLine.replace('RUN ', ''), lines: lines.all };
  }

  /** The recovering side: an engine in this process, counting what its handlers run. */
  async function recoverer(flow: 'forward' | 'rollback') {
    const seen = { steps: [] as string[], compensations: [] as string[], events: [] as string[] };
    const probe: Probe = {
      step: (name, key) => void seen.steps.push(`${name} ${key}`),
      compensate: (name, key, forwardKey) =>
        void seen.compensations.push(`${name} ${key} ${forwardKey}`),
    };
    const engine = kit.engine({
      queueName: QUEUE,
      heartbeatMs: 100,
      onEvent: (event: WorkflowEvent) => {
        const step = 'stepName' in event ? event.stepName : '-';
        const attempt = 'attempt' in event ? event.attempt : '-';
        seen.events.push(`${event.type} ${step} ${attempt}`);
      },
    });
    await engine.register(flow === 'forward' ? forwardFlow(probe) : rollbackFlow(probe));
    return { engine, seen };
  }

  /** Ticks until the run reaches `state`, counting the runs the tick took. Fails after 20 s. */
  async function tickUntil(
    engine: Awaited<ReturnType<typeof recoverer>>['engine'],
    id: string,
    state: 'completed' | 'failed'
  ) {
    let taken = 0;
    const deadline = Date.now() + 20_000;
    let exec: Execution | null = null;
    while (Date.now() < deadline) {
      const pass = await kit.tick({ queueName: QUEUE, idleMs: IDLE_MS });
      taken += pass.workflows.recovered;
      exec = await engine.getExecution(id);
      if (exec?.state === state && (state === 'completed' || exec.rollbackStatus !== undefined)) {
        return { exec, taken };
      }
      await pause(100);
    }
    throw new Error(`run ${id} did not reach ${state}: ${exec?.state} (${exec?.failureReason})`);
  }

  /** `step:started` events of both processes: a (step, attempt) pair must not appear twice. */
  function startedAttempts(child: string[], own: string[]): string[] {
    return [...child, ...own]
      .filter((line) => line.startsWith('EVENT step:started') || line.startsWith('step:started'))
      .map((line) => line.replace('EVENT ', ''));
  }

  test('between two steps: the tick resumes the run once, and the finished step does not run again', async () => {
    const child = await crashAt('forward', 'after-step:a');
    expect(child.lines.filter((line) => line.startsWith('STEP '))).toEqual([
      expect.stringMatching(/^STEP a /),
    ]);

    const { engine, seen } = await recoverer('forward');
    expect((await engine.getExecution(child.id))?.state).toBe('running');
    const { exec, taken } = await tickUntil(engine, child.id, 'completed');

    expect(taken).toBe(1);
    expect(seen.steps.map((line) => line.split(' ')[0])).toEqual(['b', 'c']);
    expect(Object.values(exec.steps).map((record) => record.attempts)).toEqual([1, 1, 1]);
    const started = startedAttempts(child.lines, seen.events);
    expect(started.toSorted()).toEqual([
      'step:started a 1',
      'step:started b 1',
      'step:started c 1',
    ]);
  }, 30_000);

  test('in the middle of a step: the step runs again as a new attempt with the same key', async () => {
    const child = await crashAt('forward', 'in-step:b');
    const before = child.lines.filter((line) => line.startsWith('STEP '));
    expect(before.map((line) => line.split(' ')[1])).toEqual(['a', 'b']);

    const { engine, seen } = await recoverer('forward');
    const { exec, taken } = await tickUntil(engine, child.id, 'completed');

    expect(taken).toBe(1);
    expect(seen.steps.map((line) => line.split(' ')[0])).toEqual(['b', 'c']);
    // The key is stable across the crash, so the provider sees the same operation twice.
    expect(seen.steps[0]).toBe(before[1]!.replace('STEP ', ''));
    expect(exec.steps.b?.attempts).toBe(2);
    const started = startedAttempts(child.lines, seen.events);
    expect(new Set(started).size).toBe(started.length);
    expect(started.toSorted()).toEqual([
      'step:started a 1',
      'step:started b 1',
      'step:started b 2',
      'step:started c 1',
    ]);
  }, 30_000);

  test('a crash between two compensations: the one already recorded is not run again', async () => {
    const child = await crashAt('rollback', 'before-compensation:a');
    expect(
      child.lines.filter((line) => line.startsWith('COMPENSATE ')).map((l) => l.split(' ')[1])
    ).toEqual(['b']);

    const { engine, seen } = await recoverer('rollback');
    const { exec, taken } = await tickUntil(engine, child.id, 'failed');

    expect(taken).toBe(1);
    expect(exec.rollbackStatus).toBe('completed');
    expect(seen.compensations.map((line) => line.split(' ')[0])).toEqual(['a']);
    expect(exec.steps.a?.compensation?.status).toBe('compensated');
    expect(exec.steps.b?.compensation?.status).toBe('compensated');
    // Forward work was not repeated by the rollback.
    expect(seen.steps).toEqual([]);
  }, 30_000);

  test('a crash inside a compensation handler: it runs again with the same keys, once more, and the rollback completes', async () => {
    const child = await crashAt('rollback', 'in-compensation:b');
    const first = child.lines.find((line) => line.startsWith('COMPENSATE b '))!;

    const { engine, seen } = await recoverer('rollback');
    const { exec, taken } = await tickUntil(engine, child.id, 'failed');

    expect(taken).toBe(1);
    expect(exec.rollbackStatus).toBe('completed');
    expect(seen.compensations.map((line) => line.split(' ')[0])).toEqual(['b', 'a']);
    // The repeat is the same operation to the provider: same compensation key, same forward key.
    expect(seen.compensations[0]).toBe(first.replace('COMPENSATE ', ''));
    expect(exec.steps.a?.compensation?.status).toBe('compensated');
    expect(exec.steps.b?.compensation?.status).toBe('compensated');
    await pause(IDLE_MS + 400);
    const later = await engine.getExecution(child.id);
    expect(later?.version).toBe(exec.version);
  }, 30_000);

  test('the tick does not take a slow step whose engine is alive, because the node keeps writing the run', async () => {
    let runs = 0;
    const engine = kit.engine({ queueName: QUEUE, heartbeatMs: 100 });
    await engine.register(
      defineWorkflow('crash-slow').step('slow', async () => {
        runs += 1;
        await pause(IDLE_MS * 2);
      })
    );
    const run = await engine.start('crash-slow', {});
    let taken = 0;
    const deadline = Date.now() + 20_000;
    while ((await engine.getExecution(run.id))?.state !== 'completed' && Date.now() < deadline) {
      taken += (await kit.tick({ queueName: QUEUE, idleMs: IDLE_MS })).workflows.recovered;
      await pause(100);
    }
    expect((await engine.getExecution(run.id))?.state).toBe('completed');
    expect([taken, runs]).toEqual([0, 1]);
  }, 30_000);
});
