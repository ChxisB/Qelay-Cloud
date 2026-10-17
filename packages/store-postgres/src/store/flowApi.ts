import type {
  FlatFlowNode,
  FlowActionRequest,
  FlowActionResult,
  FlowDependencies,
  FlowRootsPage,
  FlowTree,
  FlowView,
} from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { flowAction } from './flowActions';
import type { FlowAdded } from './flowAdd';
import { addFlow } from './flowAdd';
import type { FlowTreeLimits } from './flowReads';
import { childrenValues, dependencies, flowTree, recordedFailures } from './flowReads';
import { childIdsOf, flowView, listFlowRoots } from './flowView';

/**
 * Flows (`store.flows`): written in one transaction, settled by the terminal hook (`flowTerminal.ts`),
 * read back by the parent's processor and the inspector. Callers ring the bells in `FlowAdded` after
 * the commit, as for `enqueue`.
 */
export interface FlowApi {
  /**
   * Writes the flow (`flattenFlow` of a tree): every job or none. A root whose custom id is live is the
   * answer and nothing is written (`created: false`). Throws `FlowError` for a flow that cannot be written.
   */
  add(nodes: readonly FlatFlowNode[]): Promise<FlowAdded>;
  /** The results of the completed children of a parent, by `"<queue>:<id>"`. */
  childrenValues(parentId: string): Promise<Record<string, unknown>>;
  /** The children a parent still waits for and the results of those that completed. */
  dependencies(parentId: string): Promise<FlowDependencies>;
  /** The errors of children that failed under `continueParentOnFailure`, by `"<queue>:<id>"`. */
  failedChildren(parentId: string): Promise<Record<string, string>>;
  /** The errors of children that failed under `ignoreDependencyOnFailure`, by `"<queue>:<id>"`. */
  ignoredFailures(parentId: string): Promise<Record<string, string>>;
  /** The flow under a job as it is now, or null if there is no such job. `limits` bounds what is read. */
  tree(rootId: string, limits?: FlowTreeLimits): Promise<FlowTree | null>;
  /** One page of the flows of the namespace, newest first, with how the jobs of each are doing. */
  roots(page: { readonly limit: number; readonly offset?: number }): Promise<FlowRootsPage>;
  /**
   * The flow whose root is `rootId` as a list of jobs, top level first, at most `limit` of them
   * (`truncated` says there are more), or null if no flow has that root. For the control API.
   */
  view(rootId: string, options?: { readonly limit?: number }): Promise<FlowView | null>;
  /** The ids of the jobs that name `parentId` as their parent, at most `limit`, in id order. */
  childIds(parentId: string, limit: number): Promise<readonly string[]>;
  /**
   * An operator's action on the flow `rootId` (`retry-failed`, `promote`, `remove`): one transaction,
   * fenced by the version of every job it touches, applied whole or refused (`FlowRefusal`). Throws
   * `JobVersionError` when a job moved since it was read. Callers ring `rings` after the commit.
   */
  act(rootId: string, request: FlowActionRequest): Promise<FlowActionResult>;
}

export const flowApi = (ctx: StoreContext): FlowApi => ({
  add: (nodes) => addFlow(ctx, nodes),
  childrenValues: (parentId) => childrenValues(ctx, parentId),
  dependencies: (parentId) => dependencies(ctx, parentId),
  failedChildren: (parentId) => recordedFailures(ctx, parentId, 'continue'),
  ignoredFailures: (parentId) => recordedFailures(ctx, parentId, 'ignore'),
  tree: (rootId, limits) => flowTree(ctx, rootId, limits),
  roots: (page) => listFlowRoots(ctx, page),
  view: (rootId, options) => flowView(ctx, rootId, options),
  childIds: (parentId, limit) => childIdsOf(ctx, parentId, limit),
  act: (rootId, request) => flowAction(ctx, rootId, request),
});
