/**
 * Property-based state-machine model for the Workflow Engine, on Postgres.
 *
 * Generates a random workflow graph (timed gates, pivots, child workflows, fallible compensations),
 * starts it unconditionally, then applies a random operator history: signals, settles, restarts,
 * live recovery, recovery timed into an unwind, resume and abandon. Every action checks the persisted
 * state against the handler ledger. See `invariants.ts`, `childInvariants.ts` and
 * `rollbackInvariants.ts` for what is asserted.
 *
 * On failure fast-check shrinks and prints the seed, the spec and the command history. Replay with:
 *
 *   QCLOUD_WFMODEL_SEED=123 QCLOUD_WFMODEL_RUNS=200 bun test test/model/wfengine
 *
 * **Changed from upstream:** needs Postgres (skipped without it unless `QCLOUD_REQUIRE_DB=1`); the
 * SQLite pagination property lives with the store's own model in `test/model/workflow`.
 */

import { afterAll, expect, test } from 'bun:test';
import fc from 'fast-check';
import type { Execution } from '../../../packages/sdk/src';
import { Workflow } from '../../../packages/sdk/src';
import { describeDb } from '../../support/db';
import { workflowCommandArbitraries } from './commands';
import { disposeCampaign, RealWorkflow, type WorkflowModel } from './harness';
import { checkCompensationDispatches } from './rollbackInvariants';
import type { Ledger, LedgerCall, WorkflowSpec } from './spec';
import { workflowSpec } from './spec';

const DEFAULT_RUNS = 40;
const DEFAULT_COMMANDS = 12;

describeDb('Workflow engine state-machine model', () => {
  afterAll(async () => {
    await disposeCampaign();
  });

  test('workflow builders reject every generated invalid numeric bound', () => {
    const invalidTimeout = fc.constantFrom(
      -1,
      -0.1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY
    );
    const invalidIterations = fc.constantFrom(
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1
    );
    const invalidPositiveDuration = fc.oneof(invalidTimeout, fc.constant(0));
    fc.assert(
      fc.property(
        invalidTimeout,
        invalidIterations,
        invalidPositiveDuration,
        (timeout, maxIterations, positiveDuration) => {
          expect(() =>
            new Workflow('invalid-step').step('work', () => null, { timeout })
          ).toThrow();
          expect(() => new Workflow('invalid-wait').waitFor('event', { timeout })).toThrow();
          expect(() =>
            new Workflow('invalid-loop').doUntil(
              () => false,
              (loop) => loop.step('work', () => null),
              { maxIterations }
            )
          ).toThrow();
          expect(() =>
            new Workflow('invalid-each').forEach(
              () => [],
              'work',
              () => null,
              { maxIterations }
            )
          ).toThrow();
          expect(() =>
            new Workflow('invalid-child-timeout').subWorkflow('child', () => ({}), {
              timeout: positiveDuration,
            })
          ).toThrow();
          expect(() =>
            new Workflow('invalid-child-poll').subWorkflow('child', () => ({}), {
              pollInterval: positiveDuration,
            })
          ).toThrow();
        }
      )
    );
  });

  test('force-close replay is bounded by Engine generation and a stable idempotency key', () => {
    const spec: WorkflowSpec = {
      name: 'replay',
      nodes: [
        {
          kind: 'step',
          step: { name: 'charge', behavior: 'fail', retry: 1, compensation: 'ok' },
        },
      ],
    };
    const execution: Execution = {
      id: 'wf-replay',
      workflowName: spec.name,
      state: 'failed',
      input: {},
      steps: {},
      currentNodeIndex: 0,
      signals: {},
      createdAt: 1,
      updatedAt: 1,
    };
    const call = (
      engineGeneration: number,
      idempotencyKey = 'wf-replay:charge#0:compensate',
      forwardIdempotencyKey = 'wf-replay:charge#0:forward'
    ) =>
      ({
        executionId: execution.id,
        name: 'charge',
        occurrence: 0,
        idempotencyKey,
        forwardIdempotencyKey,
        outcome: 'completed' as const,
        engineGeneration,
      }) satisfies LedgerCall;
    const check = (compensations: LedgerCall[]) => {
      const ledger: Ledger = { steps: [], maps: [], compensations, operatorActions: [] };
      checkCompensationDispatches(spec, ledger, [execution], (id, detail): never => {
        throw new Error(`${id}: ${detail}`);
      });
    };

    expect(() => check([call(0), call(1)])).not.toThrow();
    expect(() => check([call(0), call(0)])).toThrow(/same-generation/);
    expect(() => check([call(0), call(1, 'different-key')])).toThrow(/idempotency/);
    expect(() => check([call(0), call(1, undefined, 'different-forward-key')])).toThrow(
      /forward identity/
    );
  });

  test('generated graphs and operator histories preserve every invariant', async () => {
    const seed = optionalInteger(Bun.env.QCLOUD_WFMODEL_SEED);
    const numRuns = optionalInteger(Bun.env.QCLOUD_WFMODEL_RUNS) ?? DEFAULT_RUNS;
    const maxCommands = optionalInteger(Bun.env.QCLOUD_WFMODEL_COMMANDS) ?? DEFAULT_COMMANDS;
    let run = 0;

    await fc.assert(
      fc.asyncProperty(
        workflowSpec(),
        fc.commands(workflowCommandArbitraries(), { maxCommands }),
        async (spec, commands) => {
          const real = await RealWorkflow.create(spec, `${seed ?? 'r'}-${run++}`);
          const model: WorkflowModel = { implicitStart: true };
          try {
            // Every generated case executes a workflow even when fast-check draws an
            // empty command history. Operator commands model interleavings after the
            // real start; start itself is not optional model input.
            await real.start();
            await fc.asyncModelRun(() => ({ model, real }), commands);
            await real.assertSettles();
          } finally {
            await real.dispose();
          }
        }
      ),
      {
        endOnFailure: true,
        interruptAfterTimeLimit: 150_000,
        markInterruptAsFailure: false,
        numRuns,
        seed,
        verbose: 2,
      }
    );
  }, 180_000);
});

function optionalInteger(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`expected a signed safe integer, received ${value}`);
  }
  return parsed;
}
