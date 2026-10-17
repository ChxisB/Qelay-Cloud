import type {
  EnqueuedJob,
  FlatFlowNode,
  FlowJobOptions,
  FlowTree,
  JobOptions,
  NewFlowNode,
} from '@qelay-cloud/core';
import {
  flattenFlow,
  FlowError,
  MAX_FLOW_DEPTH,
  MAX_FLOW_JOBS,
  validateJobOptions,
} from '@qelay-cloud/core';
import type { JobDetails } from '@qelay-cloud/store-postgres';
import type { FlowJob, FlowOpts, JobNode } from './flowTypes';
import { createJob, fromDetails } from './job';
import type { Runtime } from './runtime';

// Adapted from Qelay's `src/client/flowPlan.ts`, `flowOptions.ts` and `flowReader.ts` (see docs/PORTING.md).

/** The runtime a job of `queue` reads and writes through: the producer's store and doorbell, the job's queue name. */
export const forQueue = (rt: Runtime, queue: string): Runtime =>
  queue === rt.name ? rt : { ...rt, name: queue };

interface Draft {
  readonly queue: string;
  readonly name: string;
  readonly data: unknown;
  readonly options: FlowJobOptions;
  readonly children: Draft[];
}

/**
 * Turns a `FlowJob` tree into the `NewFlowNode` tree the store takes, each job's options merged over
 * the producer's `defaultJobOptions` and the queue's `queuesOptions`. Walks with a stack of its own, so
 * a deep or cyclic input is refused (`FlowError`) before the call stack or the heap is at risk; the
 * rest of what a flow may not be is checked by `flattenFlow`.
 */
export function toFlowTree(root: FlowJob, rt: Runtime, flowOpts: FlowOpts = {}): NewFlowNode {
  const perQueue = new Map<string, JobOptions>();
  const defaultsOf = (queue: string): JobOptions => {
    let found = perQueue.get(queue);
    if (found === undefined) {
      found = {
        ...rt.defaults,
        ...validateJobOptions(flowOpts.queuesOptions?.[queue]?.defaultJobOptions),
      };
      perQueue.set(queue, found);
    }
    return found;
  };
  const draft = (flow: FlowJob): Draft => {
    if (typeof flow !== 'object' || flow === null)
      throw new FlowError('a flow node must be an object');
    const { queueName: queue, name, opts } = flow;
    if (typeof queue !== 'string' || queue === '' || queue.includes('\0')) {
      throw new FlowError('a flow node needs a queueName: a non-empty string without NUL');
    }
    if (typeof name !== 'string')
      throw new FlowError(`a flow node of queue "${queue}" needs a name`);
    if (opts !== undefined && (typeof opts !== 'object' || opts === null)) {
      throw new FlowError('options must be an object');
    }
    return {
      queue,
      name,
      data: flow.data,
      options: { ...defaultsOf(queue), ...opts },
      children: [],
    };
  };

  const top = draft(root);
  const seen = new Set<object>([root]);
  const stack = [{ source: root, target: top, depth: 1 }];
  let count = 1;
  while (stack.length > 0) {
    const { source, target, depth } = stack.pop()!;
    const children: unknown = source.children ?? [];
    if (!Array.isArray(children)) throw new FlowError('children must be an array of flow nodes');
    if (children.length > 0 && depth >= MAX_FLOW_DEPTH) {
      throw new FlowError(`a flow is at most ${MAX_FLOW_DEPTH} levels deep`);
    }
    for (const child of children as FlowJob[]) {
      if (typeof child === 'object' && child !== null) {
        if (seen.has(child)) throw new FlowError('a flow node appears more than once in the tree');
        seen.add(child);
      }
      if (++count > MAX_FLOW_JOBS) throw new FlowError(`a flow has at most ${MAX_FLOW_JOBS} jobs`);
      const next = draft(child);
      target.children.push(next);
      stack.push({ source: child, target: next, depth: depth + 1 });
    }
  }
  return top;
}

/**
 * Everything that can be checked about a flow without the database, in one place: the tree's shape and
 * limits, and the options of every job (the store checks them too, but only inside its transaction, and
 * `addBulk` promises that a bad flow is found before the first flow is written).
 */
export function planFlow(root: FlowJob, rt: Runtime, flowOpts?: FlowOpts): FlatFlowNode[] {
  const plan = flattenFlow(toFlowTree(root, rt, flowOpts));
  for (const node of plan) validateJobOptions(node.job.options);
  return plan;
}

/** The node tree of a flow that was just written, from the flat list and what the store answered for each job. */
export function createdNodes(
  rt: Runtime,
  flat: readonly FlatFlowNode[],
  jobs: readonly EnqueuedJob[],
  now: number
): JobNode {
  const kids: JobNode[][] = flat.map(() => []);
  let top: JobNode | undefined;
  // Children come after their parent in the list, so walking backwards finishes each node's children first.
  for (let at = flat.length - 1; at >= 0; at--) {
    const node = flat[at]!;
    const options = validateJobOptions(node.job.options);
    const job = createJob(forQueue(rt, node.job.queue), {
      id: jobs[at]!.id,
      name: node.job.name ?? 'default',
      data: node.job.data,
      opts: options,
      timestamp: now,
      priority: options.priority ?? 0,
      attemptsMade: 0,
      progress: 0,
      duplicated: false,
    });
    const built: JobNode = kids[at]!.length > 0 ? { job, children: kids[at]!.reverse() } : { job };
    if (node.parentIndex === null) top = built;
    else kids[node.parentIndex]!.push(built);
  }
  return top!;
}

/** Ids per `detailsMany` call: well under its page limit. */
const READ_BATCH = 500;

/**
 * The node tree of a flow as the store has it now. A job that has no row (a child removed when it
 * completed, and what hangs under it) is left out. `duplicatedRoot` marks the root `duplicated`, for a
 * flow `add` found already there.
 */
export async function loadNodes(
  rt: Runtime,
  tree: FlowTree,
  duplicatedRoot: boolean
): Promise<JobNode | null> {
  const ids: string[] = [];
  for (const pending = [tree]; pending.length > 0;) {
    const node = pending.pop()!;
    ids.push(node.id);
    pending.push(...node.children);
  }
  const details = new Map<string, JobDetails>();
  for (let from = 0; from < ids.length; from += READ_BATCH) {
    for (const found of await rt.store.control.detailsMany(ids.slice(from, from + READ_BATCH))) {
      details.set(found.id, found);
    }
  }
  // The tree is at most MAX_FLOW_DEPTH deep (the store stops there), so recursion is bounded.
  const build = (node: FlowTree, root: boolean): JobNode | null => {
    const found = details.get(node.id);
    if (found === undefined) return null;
    const children = node.children.flatMap((child) => build(child, false) ?? []);
    const job = fromDetails(forQueue(rt, found.queue), found, root && duplicatedRoot);
    return children.length > 0 ? { job, children } : { job };
  };
  return build(tree, true);
}
