import { FlowError } from './errors';
import type { JobOptions, JobState, NewJob } from './jobs';

// Adapted from Qelay's `src/client/flowPlan.ts` and `flowOptions.ts` (see docs/PORTING.md).

/** Deepest flow `addFlow` takes: a root is depth 1. Upstream's `MAX_FLOW_DEPTH`. */
export const MAX_FLOW_DEPTH = 100;
/**
 * Most jobs one flow may hold, the root included. Upstream allows 10,000; here a flow is written in one
 * transaction that takes one advisory lock per job, so it is held to one enqueue batch (docs/compat.md).
 */
export const MAX_FLOW_JOBS = 1000;

/**
 * What a child's terminal failure does to its parent, set on the child:
 * - `fail`: the parent fails with the child's error.
 * - `continue`: the parent is released at once, whatever its other children are doing; the failure is
 *   recorded for the parent to read.
 * - `ignore`: this child no longer holds the parent back; the failure is recorded for the parent.
 * - `remove`: this child no longer holds the parent back; nothing is recorded.
 * A child that sets none leaves the parent waiting on it.
 */
export type FlowFailureMode = 'fail' | 'continue' | 'ignore' | 'remove';

/** The four options a flow child sets to say what its failure does to its parent (Qelay's names). */
export interface FlowChildOptions {
  readonly failParentOnFailure?: boolean;
  readonly continueParentOnFailure?: boolean;
  readonly ignoreDependencyOnFailure?: boolean;
  readonly removeDependencyOnFailure?: boolean;
}

export type FlowJobOptions = JobOptions & FlowChildOptions;

/** One job of a flow and the jobs that must finish before it runs. */
export interface NewFlowNode {
  readonly queue: string;
  readonly name?: string;
  readonly data?: unknown;
  readonly options?: FlowJobOptions;
  readonly children?: readonly NewFlowNode[];
}

/**
 * Where a parent stands with its children (`Job.getDependencies`): `processed` holds the result of each
 * completed child and `unprocessed` the children it still waits for, both by `"<queue>:<id>"`. A child
 * whose failure was recorded under `continue`, `ignore` or `remove` is in neither: it no longer counts.
 */
export interface FlowDependencies {
  readonly processed: Readonly<Record<string, unknown>>;
  readonly unprocessed: readonly string[];
}

/** One job of a flow as it is now, with the jobs under it. */
export interface FlowTree {
  readonly id: string;
  readonly queue: string;
  readonly state: JobState;
  readonly children: readonly FlowTree[];
}

/** Precedence when a child sets more than one policy, as upstream: fail, continue, ignore, remove. */
const POLICIES: ReadonlyArray<readonly [keyof FlowChildOptions, FlowFailureMode]> = [
  ['failParentOnFailure', 'fail'],
  ['continueParentOnFailure', 'continue'],
  ['ignoreDependencyOnFailure', 'ignore'],
  ['removeDependencyOnFailure', 'remove'],
];

/** Splits a node's options into the job's own and the child's policy. Throws `FlowError` for a non-boolean flag. */
export function splitFlowOptions(options: FlowJobOptions | undefined): {
  readonly job: JobOptions;
  readonly mode: FlowFailureMode | null;
  readonly flagged: boolean;
} {
  if (options === undefined) return { job: {}, mode: null, flagged: false };
  if (typeof options !== 'object' || options === null) {
    throw new FlowError('options must be an object');
  }
  const job: Record<string, unknown> = {};
  let mode: FlowFailureMode | null = null;
  let flagged = false;
  const names = new Set<string>(POLICIES.map(([name]) => name));
  for (const [key, value] of Object.entries(options)) {
    if (!names.has(key)) {
      job[key] = value;
      continue;
    }
    if (typeof value !== 'boolean') throw new FlowError(`option "${key}" must be a boolean`);
    if (value) flagged = true;
  }
  for (const [name, candidate] of POLICIES) {
    if (options[name] === true) {
      mode = candidate;
      break;
    }
  }
  return { job: job as JobOptions, mode, flagged };
}

/** A node of a flattened flow: the job to write and the node it waits for. */
export interface FlatFlowNode {
  /** Position in the flat list: pre-order, so the root is 0 and a parent comes before its children. */
  readonly index: number;
  /** The node this one is a child of, or null for the root. */
  readonly parentIndex: number | null;
  /** The job, its options without the failure policy flags. */
  readonly job: NewJob;
  /** What this node's failure does to its parent. Always null for the root. */
  readonly mode: FlowFailureMode | null;
  /** True for a node with children: it is written `waiting-children`. */
  readonly hasChildren: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Flattens a flow into the list `addFlow` writes, and refuses a flow that cannot be written, before
 * anything is: more than `MAX_FLOW_DEPTH` levels or `MAX_FLOW_JOBS` jobs, a node object used twice (a
 * shared node or a cycle), a custom id used twice or containing ":", a failure policy on the root, `deduplication`
 * (a dedup key is about one job, not a tree), a group on a job that has children, and a child that is
 * removed when it fails but sets no policy (its parent would wait for a job that no longer exists).
 * Walks with a stack of its own, so a deep input cannot overflow the call stack before the limit applies.
 */
export function flattenFlow(root: NewFlowNode): FlatFlowNode[] {
  const nodes: FlatFlowNode[] = [];
  const seen = new Set<object>();
  const ids = new Set<string>();
  const stack: Array<{ node: NewFlowNode; parentIndex: number | null; depth: number }> = [
    { node: root, parentIndex: null, depth: 1 },
  ];
  while (stack.length > 0) {
    const { node, parentIndex, depth } = stack.pop()!;
    if (!isObject(node)) throw new FlowError('a flow node must be an object');
    if (seen.has(node)) throw new FlowError('a flow node appears more than once in the tree');
    seen.add(node);
    if (depth > MAX_FLOW_DEPTH)
      throw new FlowError(`a flow is at most ${MAX_FLOW_DEPTH} levels deep`);
    if (nodes.length >= MAX_FLOW_JOBS)
      throw new FlowError(`a flow has at most ${MAX_FLOW_JOBS} jobs`);
    if (typeof node.queue !== 'string') throw new FlowError('a flow node needs a queue name');
    const children = node.children ?? [];
    if (!Array.isArray(children)) throw new FlowError('children must be an array of flow nodes');
    const { job, mode, flagged } = splitFlowOptions(node.options);
    const index = nodes.length;
    const where = `flow node ${index} (queue "${node.queue}")`;
    if (parentIndex === null && flagged) {
      throw new FlowError(`${where} is the root and has no parent: it cannot set a failure policy`);
    }
    if (job.deduplication !== undefined) {
      throw new FlowError(`${where} sets deduplication, which a flow does not take`);
    }
    if (children.length > 0 && job.group !== undefined) {
      throw new FlowError(`${where} has children and cannot be in a group`);
    }
    if (parentIndex !== null && job.removeOnFail === true && mode === null) {
      throw new FlowError(
        `${where} is removed when it fails: it needs a failure policy ` +
          '(failParentOnFailure, continueParentOnFailure, ignoreDependencyOnFailure or removeDependencyOnFailure)'
      );
    }
    if (job.jobId !== undefined) {
      const id = String(job.jobId);
      // `getChildrenValues` and `getDependencies` key results as "<queue>:<id>", so an id with a colon
      // would make a key that cannot be split back. Upstream refuses it for the same reason.
      if (id.includes(':')) throw new FlowError(`${where} has a job id with a ":" in it`);
      if (ids.has(id)) throw new FlowError(`job id "${id}" is used by two jobs of the flow`);
      ids.add(id);
    }
    nodes.push({
      index,
      parentIndex,
      job: {
        queue: node.queue,
        data: node.data,
        ...(node.name !== undefined && { name: node.name }),
        options: job,
      },
      mode,
      hasChildren: children.length > 0,
    });
    // Reversed, so the first child is taken next and the list stays pre-order in the order given.
    for (let at = children.length - 1; at >= 0; at--) {
      stack.push({ node: children[at]!, parentIndex: index, depth: depth + 1 });
    }
  }
  return nodes;
}
