import type { FlowDependencies } from '@qelay-cloud/core';
import type { Runtime } from './runtime';

// Adapted from Qelay's `src/client/flowJobDependencies.ts` and `flowJobCoreMethods.ts` (see docs/PORTING.md).

/**
 * What a job that has children reads about them, on `Job` and on the job a processor receives. Each is
 * one query; a job with no children, or an unknown one, reads as empty. Keys are `"<queue>:<id>"`.
 */
export interface FlowReads {
  /** The return value of every child that completed, including those removed on completion. */
  getChildrenValues<C = unknown>(): Promise<Record<string, C>>;
  /**
   * `processed`: the results of the children that completed. `unprocessed`: the children still waited for,
   * which includes a child that failed with no failure option set. A child dropped by
   * `continueParentOnFailure`, `ignoreDependencyOnFailure` or `removeDependencyOnFailure` is in neither.
   */
  getDependencies(): Promise<FlowDependencies>;
  /** The error of each child that failed under `continueParentOnFailure`. */
  getFailedChildrenValues(): Promise<Record<string, string>>;
  /** The error of each child that failed under `ignoreDependencyOnFailure`. */
  getIgnoredChildrenFailures(): Promise<Record<string, string>>;
}

export function flowReads(rt: Runtime, id: string): FlowReads {
  return {
    getChildrenValues: <C>() => rt.store.flows.childrenValues(id) as Promise<Record<string, C>>,
    getDependencies: () => rt.store.flows.dependencies(id),
    getFailedChildrenValues: () => rt.store.flows.failedChildren(id),
    getIgnoredChildrenFailures: () => rt.store.flows.ignoredFailures(id),
  };
}
