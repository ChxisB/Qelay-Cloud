import type { Execution } from './workflowTypes';

export interface Wait {
  event: string;
  deadlineAt: number | null;
  leaseUntil: number | null;
}

export interface Row {
  exec: Execution;
  wait: Wait | null;
}

export const copy = (exec: Execution): Execution => structuredClone(exec);
export const byCreated = (a: Execution, b: Execution): number =>
  b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
export const byProgress = (a: Execution, b: Execution): number =>
  a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** What a step-level write never changes: the run's identity, its input and the signals delivered to it. */
export function keepIdentity(next: Execution, stored: Execution): void {
  next.workflowName = stored.workflowName;
  next.input = stored.input;
  next.signals = stored.signals;
  next.createdAt = stored.createdAt;
}
