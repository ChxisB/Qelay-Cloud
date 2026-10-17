import { afterAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../support/db';
import type { ModelCommand } from './command';
import { EnqueueCommand, ClaimCommand, LeaseCommand } from './commands-jobs';
import { closePostgresTarget, postgresFactory } from './postgresTarget';
import type { JobSpec } from './reference';
import type { RingFault } from './transport';
import { VirtualClock } from './transport';
import { WorkerBridge } from './workers';
import {
  ALL_CHECKS,
  InvariantViolation,
  LOCK_TTL_MS,
  NAMESPACE,
  TICK_INTERVAL_MS,
  World,
} from './world';

/**
 * The bridge that puts real `Worker`s into the model run, checked on scripted histories: that the
 * worker does take the bell and make the writes (a model run that passes could also mean the
 * bridge did nothing), and what it does with a bell it has no slot for, a lease nobody holds and
 * an answer the model rejects.
 */
const JOB: JobSpec = { queue: 'alpha', priority: 0, lifo: false, delayMs: 0, maxAttempts: 1 };

afterAll(closePostgresTarget);

describeDb('model harness: real workers', () => {
  let world: World;
  let bridge: WorkerBridge;

  beforeEach(async () => {
    const clock = new VirtualClock();
    const store = await postgresFactory({
      clock,
      namespace: NAMESPACE,
      lockTtlMs: LOCK_TTL_MS,
      reRingAfterMs: TICK_INTERVAL_MS,
    });
    world = new World(store, clock, new Set(ALL_CHECKS));
    bridge = new WorkerBridge(world);
    world.bridge = bridge;
    return async () => {
      await bridge.close();
      await store.close();
    };
  });

  const run = (command: ModelCommand) => command.run(world.model, world);
  const enqueue = (spec: Partial<JobSpec> = {}) =>
    run(new EnqueueCommand('enqueue', { ...JOB, ...spec }, null, 'ok'));
  const claim = () => run(new ClaimCommand('w0', 1, 0));
  const lease = (name: 'complete' | 'fail' | 'release', op = name, fault: RingFault = 'ok') =>
    run(new LeaseCommand(name, op, 0, fault));
  const phases = () => [...world.model.jobs.values()].map((job) => job.phase);

  test('a worker takes the bell, claims the job, and writes the completion the command asks for', async () => {
    await enqueue();
    await claim();
    expect(bridge.stats).toMatchObject({ delivered: 1, claimed: 1, returned: 0 });
    expect(phases()).toEqual(['active']);
    await lease('complete');
    expect(bridge.stats.finished).toBe(1);
    expect(phases()).toEqual(['completed']);
  });

  test('a failed attempt is rung by the worker, and the bell claims the job again', async () => {
    await enqueue({ maxAttempts: 2 });
    await claim();
    await lease('fail');
    expect(phases()).toEqual(['pending']);
    expect(world.bells.deliverable('alpha')).toBe(1);
    await claim();
    await lease('complete');
    expect(bridge.stats).toMatchObject({ claimed: 2, finished: 2 });
    expect(phases()).toEqual(['completed']);
  });

  test('an unrecoverable failure ends the job whatever attempts are left', async () => {
    await enqueue({ maxAttempts: 3 });
    await claim();
    await run(new LeaseCommand('fail', 'fail-unrecoverable', 0, 'ok'));
    expect(phases()).toEqual(['failed']);
  });

  test('a dropped ring of the worker is a bell the model no longer has, and the tick is what repairs it', async () => {
    await enqueue({ maxAttempts: 2 });
    await claim();
    await lease('fail', 'fail', 'drop');
    expect(world.bells.deliverable('alpha')).toBe(0);
    expect(phases()).toEqual(['pending']);
  });

  test('a worker with no free slot returns the bell, and the harness puts it back', async () => {
    for (let i = 0; i < 3; i += 1) await enqueue();
    await claim(); // two slots: one bell takes two jobs
    await claim(); // none left: nacked, so the bell is back
    expect(bridge.stats).toMatchObject({ delivered: 2, claimed: 2, returned: 1 });
    expect(world.bells.deliverable('alpha')).toBe(2);
    expect(phases().filter((phase) => phase === 'pending')).toHaveLength(1);
  });

  test('a lease the model gave back is thrown out of its worker, whose late write the store refuses', async () => {
    await enqueue();
    await claim();
    await lease('release');
    expect(phases()).toEqual(['pending']);
    await claim(); // reaps the old processor, then the worker takes the job again
    expect(bridge.stats).toMatchObject({ reaped: 1, claimed: 2 });
    await lease('complete');
    expect(phases()).toEqual(['completed']);
  });

  test('a claim the model rejects fails the run, though the worker would only log it', async () => {
    // A job the model never saw: the store claims it, the model has no such job.
    await world.store.enqueue([{ queue: 'alpha', data: { generation: 0 }, options: {} }]);
    world.bells.ring([{ namespace: NAMESPACE, queue: 'alpha' }], 'ok');
    await expect(claim()).rejects.toBeInstanceOf(InvariantViolation);
  });
});
