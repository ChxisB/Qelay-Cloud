/** Durable workflow-node publication shared by execution, signalling and recovery. */

import { WORKFLOW_STEP_JOB } from '@qelay-cloud/core';
import type { Queue } from '../queue';
import type { Execution, StepJobData } from './types';

/** The job name every node job carries. */
export const STEP_JOB = WORKFLOW_STEP_JOB;

/**
 * Publish one node without a deterministic job id. The cursor and in-flight guards
 * discard overlapping duplicates, while queue-level dedup could suppress a legitimate
 * re-enqueue after recovery and wedge the execution permanently.
 */
export async function enqueueWorkflowStep(
  queue: Queue<StepJobData>,
  exec: Execution,
  assertActive: () => void
): Promise<void> {
  assertActive();
  const jobData: StepJobData = {
    executionId: exec.id,
    workflowName: exec.workflowName,
    nodeIndex: exec.currentNodeIndex,
  };
  await queue.add(STEP_JOB, jobData);
}
