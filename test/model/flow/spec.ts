import type { NewFlowNode } from '@qelay-cloud/core';
import type { Arbitrary } from 'fast-check';
import fc from 'fast-check';

/** What a child does to its parent when it fails: its policy. `null` is none, so the parent keeps waiting. */
export type Mode = 'fail' | 'continue' | 'ignore' | 'remove';

export const FLOW_QUEUES = ['qa', 'qb', 'qc'] as const;
export type FlowQueue = (typeof FLOW_QUEUES)[number];

/** One job of a generated flow. The root has no policy: it has no parent. */
export interface NodeSpec {
  readonly queue: FlowQueue;
  readonly mode: Mode | null;
  readonly children: readonly NodeSpec[];
}

const OPTION_OF: Record<Mode, string> = {
  fail: 'failParentOnFailure',
  continue: 'continueParentOnFailure',
  ignore: 'ignoreDependencyOnFailure',
  remove: 'removeDependencyOnFailure',
};

const queue = fc.constantFrom<FlowQueue>(...FLOW_QUEUES);
// Weighted towards no policy and `fail`, the two that decide most outcomes, with each other kept common.
const mode = fc.constantFrom<Mode | null>(
  null,
  null,
  'fail',
  'fail',
  'continue',
  'ignore',
  'remove'
);

const leaf: Arbitrary<NodeSpec> = fc.record({
  queue,
  mode,
  children: fc.constant<readonly NodeSpec[]>([]),
});
const branch: Arbitrary<NodeSpec> = fc.record({
  queue,
  mode,
  children: fc.array(leaf, { minLength: 1, maxLength: 3 }),
});

const anyShape: Arbitrary<NodeSpec> = fc.record({
  queue,
  mode: fc.constant<Mode | null>(null),
  children: fc.array(fc.oneof(leaf, branch), { maxLength: 3 }),
});

/**
 * A parent with two or three leaf children in one queue, each with a policy of its own. A worker can
 * hold them all at once, so they end together (an expired lease takes them in one batch) or one after
 * another (a policy that fires late, after the parent was let go).
 */
const siblings: Arbitrary<NodeSpec> = fc
  .tuple(
    queue,
    queue,
    fc.array(fc.constantFrom<Mode | null>('fail', 'continue', 'ignore', 'remove', null), {
      minLength: 2,
      maxLength: 3,
    })
  )
  .map(([parent, child, modes]) => ({
    queue: parent,
    mode: null,
    children: modes.map((mode) => ({ queue: child, mode, children: [] })),
  }));

/**
 * A parent whose first child lets it go when it fails, and whose second can still fail afterwards: with
 * `fail` the parent is already released and nothing happens, with another policy the failure is
 * recorded (`continue`, `ignore`) or the edge dropped (`remove`) late.
 */
const lateShape = (later: Arbitrary<Mode>): Arbitrary<NodeSpec> =>
  fc.tuple(queue, queue, later).map(([parent, child, mode]) => ({
    queue: parent,
    mode: null,
    children: [
      { queue: child, mode: 'continue' as const, children: [] },
      { queue: child, mode, children: [] },
    ],
  }));

const lateFail = lateShape(fc.constant<Mode>('fail'));
const lateRecord = lateShape(fc.constantFrom<Mode>('continue', 'ignore', 'remove'));

/** A flow of up to three levels and thirteen jobs, in up to three queues. Some are a single job. */
export const flowSpec: Arbitrary<NodeSpec> = fc.oneof(
  { weight: 3, arbitrary: anyShape },
  { weight: 2, arbitrary: siblings },
  { weight: 3, arbitrary: lateFail },
  { weight: 3, arbitrary: lateRecord }
);

/** A flow as the store takes it, and its ids in pre-order (the root first). */
export interface Materialized {
  readonly tree: NewFlowNode;
  readonly ids: readonly string[];
}

/** The id of the root of flow `no`: custom, so a replay of the same flow finds it. */
export const rootIdOf = (no: number): string => `f${no}_r`;

/**
 * Builds the `NewFlowNode` tree of flow `no`. Every job has a custom id from its place in the flow
 * (`f2_r`, `f2_0`, `f2_0_1`), a single attempt, so a failure or an expired lease is final, and the
 * policy of its edge. Ids hold no ':'.
 */
export function materialize(spec: NodeSpec, no: number): Materialized {
  const ids: string[] = [];
  const build = (node: NodeSpec, path: string): NewFlowNode => {
    const id = path === '' ? rootIdOf(no) : `f${no}_${path}`;
    ids.push(id);
    return {
      queue: node.queue,
      data: id,
      options: {
        jobId: id,
        attempts: 1,
        ...(node.mode !== null && { [OPTION_OF[node.mode]]: true }),
      },
      children: node.children.map((child, at) =>
        build(child, path === '' ? `${at}` : `${path}_${at}`)
      ),
    };
  };
  const tree = build(spec, '');
  return { tree, ids };
}

/** Number of jobs in a spec, for `toString` of the commands and for shrinking reports. */
export const sizeOf = (spec: NodeSpec): number =>
  1 + spec.children.reduce((sum, child) => sum + sizeOf(child), 0);
