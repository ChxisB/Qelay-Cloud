/** The name of the job a workflow worker takes to run one step of an execution (`packages/core/src/workflowJob.ts`). */
export const WORKFLOW_STEP_JOB = 'wf:step';

/**
 * The execution a job belongs to, or null when the job is not a workflow step job. A step job's data is
 * written by the engine, but a job named like one could be added by hand, so the id is only read as text
 * and the link it makes goes to a page that reads it as an id.
 */
export function owningExecution(job: { name?: string; data?: unknown }): string | null {
  if (job.name !== WORKFLOW_STEP_JOB) return null;
  const data = job.data;
  if (typeof data !== 'object' || data === null) return null;
  const id = (data as { executionId?: unknown }).executionId;
  return typeof id === 'string' && id.length > 0 && id.length <= 256 ? id : null;
}
