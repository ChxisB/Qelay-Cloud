import type { Execution } from '@qelay-cloud/core';
import type { StepIndex } from './workflowSteps';
import { clipText } from './workflowSteps';

const MAX_FAILURES = 10;
const MAX_ERROR_CHARS = 2_000;

export interface CompensationWire {
  /** `pending`: the run failed and its unwind has not started or not finished; a worker or the tick drives it. */
  readonly status: 'none' | 'pending' | 'running' | 'stuck' | 'completed' | 'not-applicable';
  /** Completed steps that declared a reversal and have no outcome yet. */
  readonly eligible: number;
  readonly compensated: number;
  readonly failed: number;
  readonly skipped: number;
  readonly failures: Array<{ readonly step: string; readonly error: string | null }>;
}

/** Every record that stands for itself: a fan-out counts its iterations, not the copy of the latest one. */
function countable(index: StepIndex) {
  return [
    ...index.top.filter(([name]) => !index.groups.has(name)),
    ...[...index.groups.values()].flat(),
  ];
}

/** How far the unwind of a run got, from its state and its step records. */
export function compensationWire(exec: Execution, index: StepIndex): CompensationWire {
  let status: CompensationWire['status'] = 'none';
  if (exec.state === 'compensating') status = 'running';
  else if (exec.state === 'compensation-stuck') status = 'stuck';
  else if (exec.rollbackStatus === 'completed') status = 'completed';
  else if (exec.rollbackStatus === 'not-applicable') status = 'not-applicable';
  else if (exec.rollbackStatus === 'stuck') status = 'stuck';
  else if (exec.state === 'failed') status = 'pending';
  const tally = { eligible: 0, compensated: 0, failed: 0, skipped: 0 };
  const failures: CompensationWire['failures'] = [];
  for (const [name, record] of countable(index)) {
    const outcome = record.compensation?.status;
    if (outcome === 'compensated') tally.compensated += 1;
    else if (outcome === 'compensation-skipped') tally.skipped += 1;
    else if (outcome === 'compensation-failed') {
      tally.failed += 1;
      if (failures.length < MAX_FAILURES) {
        failures.push({ step: name, error: clipText(record.compensation?.error, MAX_ERROR_CHARS) });
      }
    } else if (record.compensatable === true && record.status === 'completed') tally.eligible += 1;
  }
  return { status, ...tally, failures };
}
