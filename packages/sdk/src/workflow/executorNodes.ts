/** Workflow node dispatch, split from the executor's lifecycle orchestration. */

import type { Clock } from './clock';
import type { WorkflowEmitter } from './emitter';
import { isWorkflowExecutionClosed } from './executionFence';
import { describeError } from './identity';
import { executeDoUntil, executeDoWhile, executeForEach, executeMap } from './loops';
import type { StepHooks } from './runner';
import {
  buildContext,
  executeParallelSteps,
  executeStepWithRetry,
  executeSubWorkflow,
} from './runner';
import type { RunStorage } from './storage';
import type { Execution, RunHandle, WorkflowNode } from './types';
import { runWaitFor, type WaitForDeps } from './waitFor';
import type { Workflow } from './workflow';
import {
  branchDecisionKey,
  resolveDecision,
  subWorkflowInputDecisionKey,
} from './workflowDecisions';

export interface NodeExecutionDeps {
  storage: RunStorage;
  emitter: WorkflowEmitter | null;
  clock: Clock;
  updateFn: (exec: Execution) => Promise<void>;
  advance: (exec: Execution, nextIdx: number, workflow: Workflow) => Promise<void>;
  start: (name: string, input: unknown, parentId: string) => Promise<RunHandle>;
  enqueue: (exec: Execution) => Promise<void>;
  waitFor: WaitForDeps;
  assertActive: () => void;
}

export function stepHooks(deps: NodeExecutionDeps): StepHooks {
  return {
    emitter: deps.emitter,
    updateFn: deps.updateFn,
    assertActive: deps.assertActive,
    clock: deps.clock,
  };
}

export async function executeWorkflowNode(
  deps: NodeExecutionDeps,
  exec: Execution,
  node: WorkflowNode,
  idx: number,
  wf: Workflow
): Promise<void> {
  deps.assertActive();
  const hooks = stepHooks(deps);
  if (node.type === 'step') {
    await executeStepWithRetry(node.def, buildContext(exec), exec, hooks);
  } else if (node.type === 'branch') {
    await runBranch(deps, exec, node, idx);
  } else if (node.type === 'parallel') {
    await executeParallelSteps(node.def.steps, buildContext(exec), exec, hooks);
  } else if (node.type === 'subWorkflow') {
    await runSubWorkflow(deps, exec, node, idx);
  } else if (node.type === 'doUntil') {
    await executeDoUntil(node.def, exec, hooks);
  } else if (node.type === 'doWhile') {
    await executeDoWhile(node.def, exec, hooks);
  } else if (node.type === 'forEach') {
    await executeForEach(node.def, exec, hooks);
  } else if (node.type === 'map') {
    await executeMap(node.def, exec, hooks);
  } else if (node.type === 'pivot') {
    // A pivot commits the saga before the cursor moves beyond it.
    exec.committedAt = idx;
    await deps.updateFn(exec);
  } else {
    await runWaitFor(deps.waitFor, exec, node, idx, wf);
    return;
  }

  deps.assertActive();
  await deps.advance(exec, idx + 1, wf);
}

async function runBranch(
  deps: NodeExecutionDeps,
  exec: Execution,
  node: Extract<WorkflowNode, { type: 'branch' }>,
  idx: number
): Promise<void> {
  deps.assertActive();
  const pathName = await resolveDecision(
    exec,
    branchDecisionKey(idx),
    () => node.def.condition(buildContext(exec)),
    deps.updateFn,
    deps.assertActive
  );
  deps.assertActive();
  if (typeof pathName !== 'string') {
    throw new Error(`Branch at node ${idx} returned a non-string path`);
  }
  const pathSteps = node.def.paths.get(pathName);
  if (!pathSteps) {
    throw new Error(`Branch at node ${idx} resolved unknown path "${pathName}"`);
  }

  const selectedNames = pathSteps.map((step) => step.name);
  const resolved = new Set(exec.resolvedSteps ?? []);
  const previousSize = resolved.size;
  for (const name of selectedNames) resolved.add(name);
  if (resolved.size !== previousSize) {
    exec.resolvedSteps = [...resolved];
    await deps.updateFn(exec);
  }

  const hooks = stepHooks(deps);
  for (const step of pathSteps) {
    await executeStepWithRetry(step, buildContext(exec), exec, hooks);
    deps.assertActive();
  }
}

async function runSubWorkflow(
  deps: NodeExecutionDeps,
  exec: Execution,
  node: Extract<WorkflowNode, { type: 'subWorkflow' }>,
  idx: number
): Promise<void> {
  deps.assertActive();
  const subInput = await resolveDecision(
    exec,
    subWorkflowInputDecisionKey(idx),
    () => structuredClone(node.inputMapper(buildContext(exec))),
    deps.updateFn,
    deps.assertActive
  );
  deps.assertActive();
  const recordKey = `sub:${node.name}`;
  const childExecutionId = await adoptExistingChild(deps, exec, node.name, recordKey);
  deps.assertActive();
  try {
    const { results, executionId } = await executeSubWorkflow(
      node.name,
      subInput,
      async (name, input) => {
        const handle = await deps.start(name, input, exec.id);
        deps.assertActive();
        // Claim the child before polling it. A restart can then resume the existing
        // child instead of starting another one.
        exec.steps[recordKey] = { status: 'running', childExecutionId: handle.id };
        await deps.updateFn(exec);
        return handle;
      },
      (id) => deps.storage.get(id),
      {
        pollIntervalMs: node.pollInterval,
        maxWaitMs: node.timeout,
        existingChildId: childExecutionId,
        assertActive: deps.assertActive,
        clock: deps.clock,
      }
    );
    deps.assertActive();
    exec.steps[recordKey] = {
      status: 'completed',
      result: results,
      completedAt: deps.clock.now(),
      childExecutionId: executionId,
    };
  } catch (error) {
    if (isWorkflowExecutionClosed(error)) throw error;
    deps.assertActive();
    await settleFailedChild(deps, exec, recordKey, error);
    throw error;
  }
}

async function adoptExistingChild(
  deps: NodeExecutionDeps,
  exec: Execution,
  workflowName: string,
  recordKey: string
): Promise<string | undefined> {
  deps.assertActive();
  const claimedId = exec.steps[recordKey]?.childExecutionId;
  const child = claimedId
    ? await deps.storage.get(claimedId)
    : await deps.storage.port.findChild(exec.id, workflowName);
  if (!child) return claimedId;

  if (!claimedId) {
    exec.steps[recordKey] = {
      ...exec.steps[recordKey],
      status: 'running',
      childExecutionId: child.id,
    };
    await deps.updateFn(exec);
  }
  // The child row is durable before its initial queue publication. A crash in that
  // gap leaves it running but undelivered; duplicate publication is safe because node
  // admission and persisted outcomes make it idempotent.
  if (child.state === 'running') {
    await deps.enqueue(child);
    deps.assertActive();
  }
  return child.id;
}

async function settleFailedChild(
  deps: NodeExecutionDeps,
  exec: Execution,
  recordKey: string,
  error: unknown
): Promise<void> {
  const claimed = exec.steps[recordKey];
  if (!claimed) return;

  exec.steps[recordKey] = {
    ...claimed,
    status: 'failed',
    error: describeError(error),
    completedAt: deps.clock.now(),
  };
  try {
    await deps.updateFn(exec);
  } catch (writeError) {
    if (isWorkflowExecutionClosed(writeError)) throw writeError;
    // The generic failure path persists this in-memory record. Do not replace the
    // child's diagnostic with an incidental write error.
  }
}
