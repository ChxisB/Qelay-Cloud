/** What `Engine.register` checks before a definition is accepted. */

import type { WorkflowStorePort } from '@qelay-cloud/core';
import { WorkflowDefinitionMismatchError } from './definitionGuard';
import { assertNoDuplicateWaitFor, assertNoIndexCollision, type Workflow } from './workflow';

/**
 * Refuses a definition that is empty, has duplicate names, or collides with a run that is still
 * live under a different definition. The last check is the one place a rolling deploy with a
 * changed definition is stopped: a run is bound to the hash of the definition it started under, and
 * a worker holding another one must not drive it. A `compensation-stuck` run is exempt, it waits
 * for an operator and can be abandoned.
 */
export async function checkRegistration(
  workflow: Workflow,
  port: Pick<WorkflowStorePort, 'listActive'>,
  registered: ReadonlyMap<string, Workflow>
): Promise<void> {
  if (registered.has(workflow.name)) {
    throw new Error(`Workflow "${workflow.name}" is already registered`);
  }
  if (workflow.nodes.length === 0) {
    throw new Error(`Workflow "${workflow.name}" has no steps`);
  }
  const names = workflow.getStepNames();
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length > 0) {
    throw new Error(`Duplicate step names in "${workflow.name}": ${dupes.join(', ')}`);
  }
  assertNoIndexCollision(workflow);
  assertNoDuplicateWaitFor(workflow);
  const definitionHash = workflow.seal();
  const conflict = (await port.listActive(workflow.name)).find(
    (exec) =>
      exec.state !== 'compensation-stuck' &&
      exec.definitionHash !== undefined &&
      exec.definitionHash !== definitionHash
  );
  if (conflict) throw new WorkflowDefinitionMismatchError(conflict.id, workflow.name);
}
