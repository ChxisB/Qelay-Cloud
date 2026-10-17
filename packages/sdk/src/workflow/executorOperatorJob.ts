/**
 * The `wf:step` jobs that are not a node: a rollback to drive again, and an operator's decision on a
 * parked unwind. The tick and the Control API publish them without the workflow definitions; the
 * worker that takes one holds the definition and does the work.
 */

import type { CompensationEnv } from './compensationEnv';
import type { StepJobData } from './engineTypes';
import { recoverCompensation } from './recovery';
import { abandonParkedCompensation, resumeCompensation } from './rollbackControl';
import type { RunStorage } from './storage';
import type { Workflow } from './workflow';

export interface OperatorJobDeps {
  readonly storage: RunStorage;
  readonly env: CompensationEnv;
  readonly workflows: ReadonlyMap<string, Workflow>;
  readonly assertActive: () => void;
}

/** Drive the unwind of a `compensating` run, or of a `failed` one that has no outcome yet. */
export async function recoverJob(deps: OperatorJobDeps, data: StepJobData): Promise<null> {
  const wf = deps.workflows.get(data.workflowName);
  if (!wf) throw new Error(`Workflow "${data.workflowName}" not registered`);
  await recoverCompensation(data.executionId, wf, {
    storage: deps.storage,
    env: deps.env,
    assertActive: deps.assertActive,
  });
  return null;
}

/**
 * Retry the failed reversal of a parked run, or accept the partial rollback. The operator decided
 * against a `compensation-stuck` run: when it is no longer parked (another operator or worker got
 * there first) there is nothing left to do, and nothing to retry, so the job ends.
 */
export async function operatorJob(deps: OperatorJobDeps, data: StepJobData): Promise<null> {
  deps.assertActive();
  const parked = await deps.storage.get(data.executionId);
  if (parked?.state !== 'compensation-stuck') return null;
  const rollback = { ...deps.env, workflows: deps.workflows };
  try {
    if (data.operator === 'retry-compensation') {
      await resumeCompensation(rollback, data.executionId);
    } else {
      await abandonParkedCompensation(rollback, data.executionId);
    }
  } catch (error) {
    const now = await deps.storage.get(data.executionId);
    if (now && now.state !== 'compensation-stuck') return null;
    throw error;
  }
  return null;
}
