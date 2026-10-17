/**
 * The two workflows of the crash tests. The test process and the child process build the same
 * definitions, so the child's runs are registered, and recovered, by the parent's engine. Each handler
 * reports itself to a `Probe`, which is how the test counts runs of a body across the two processes.
 */
import type { Workflow } from '../src';
import { defineWorkflow } from '../src';

export interface Probe {
  /** A forward step body starts, with the idempotency key it was given. */
  step(name: string, key: string | undefined): void | Promise<void>;
  /** A compensation handler starts, with its key and the key of the forward step. */
  compensate(
    name: string,
    key: string | undefined,
    forwardKey: string | undefined
  ): void | Promise<void>;
}

/** Three steps that succeed. */
export function forwardFlow(probe: Probe): Workflow {
  const body = (name: string) => async (ctx: { idempotencyKey?: string }) => {
    await probe.step(name, ctx.idempotencyKey);
    return name.toUpperCase();
  };
  return defineWorkflow('crash-forward')
    .step('a', body('a'))
    .step('b', body('b'))
    .step('c', body('c'));
}

/** Two steps that can be undone, then one that fails. */
export function rollbackFlow(probe: Probe): Workflow {
  const body = (name: string) => async (ctx: { idempotencyKey?: string }) => {
    await probe.step(name, ctx.idempotencyKey);
    return name.toUpperCase();
  };
  const undo =
    (name: string) => async (ctx: { idempotencyKey?: string; forwardIdempotencyKey?: string }) => {
      await probe.compensate(name, ctx.idempotencyKey, ctx.forwardIdempotencyKey);
    };
  return defineWorkflow('crash-rollback')
    .step('a', body('a'), { compensate: undo('a') })
    .step('b', body('b'), { compensate: undo('b') })
    .step(
      'c',
      async (ctx) => {
        await probe.step('c', ctx.idempotencyKey);
        throw new Error('declined');
      },
      { retry: 1 }
    );
}
