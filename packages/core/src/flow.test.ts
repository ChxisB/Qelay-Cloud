import { describe, expect, test } from 'bun:test';
import { FlowError } from './errors';
import type { NewFlowNode } from './flow';
import { flattenFlow, MAX_FLOW_DEPTH, MAX_FLOW_JOBS, splitFlowOptions } from './flow';

const chain = (depth: number): NewFlowNode => {
  let node: NewFlowNode = { queue: 'q' };
  for (let level = 1; level < depth; level++) node = { queue: 'q', children: [node] };
  return node;
};

describe('splitFlowOptions', () => {
  test('separates the failure flags from the job options', () => {
    expect(splitFlowOptions({ attempts: 3, ignoreDependencyOnFailure: true })).toEqual({
      job: { attempts: 3 },
      mode: 'ignore',
      flagged: true,
    });
  });

  test('a false flag sets no policy and is not flagged', () => {
    expect(splitFlowOptions({ failParentOnFailure: false })).toEqual({
      job: {},
      mode: null,
      flagged: false,
    });
  });

  test('precedence is fail, continue, ignore, remove', () => {
    const all = {
      removeDependencyOnFailure: true,
      ignoreDependencyOnFailure: true,
      continueParentOnFailure: true,
      failParentOnFailure: true,
    };
    expect(splitFlowOptions(all).mode).toBe('fail');
    expect(splitFlowOptions({ ...all, failParentOnFailure: false }).mode).toBe('continue');
    expect(
      splitFlowOptions({ ...all, failParentOnFailure: false, continueParentOnFailure: false }).mode
    ).toBe('ignore');
  });

  test('a flag that is not a boolean is refused', () => {
    expect(() => splitFlowOptions({ failParentOnFailure: 'yes' } as never)).toThrow(FlowError);
  });
});

describe('flattenFlow', () => {
  test('lists a tree in pre-order with the parent of each node', () => {
    const nodes = flattenFlow({
      queue: 'root',
      children: [{ queue: 'a', children: [{ queue: 'a1' }, { queue: 'a2' }] }, { queue: 'b' }],
    });
    expect(nodes.map((node) => [node.job.queue, node.parentIndex])).toEqual([
      ['root', null],
      ['a', 0],
      ['a1', 1],
      ['a2', 1],
      ['b', 0],
    ]);
    expect(nodes.map((node) => node.hasChildren)).toEqual([true, true, false, false, false]);
  });

  test('carries the policy of each child and strips the flags from the job options', () => {
    const nodes = flattenFlow({
      queue: 'root',
      children: [{ queue: 'a', options: { attempts: 2, continueParentOnFailure: true } }],
    });
    expect(nodes[0]!.mode).toBeNull();
    expect(nodes[1]!.mode).toBe('continue');
    expect(nodes[1]!.job.options).toEqual({ attempts: 2 });
  });

  test('takes a flow of exactly the depth and size limits, and refuses one more', () => {
    expect(flattenFlow(chain(MAX_FLOW_DEPTH))).toHaveLength(MAX_FLOW_DEPTH);
    expect(() => flattenFlow(chain(MAX_FLOW_DEPTH + 1))).toThrow(/levels deep/);
    const wide = (count: number): NewFlowNode => ({
      queue: 'root',
      children: Array.from({ length: count - 1 }, () => ({ queue: 'c' })),
    });
    expect(flattenFlow(wide(MAX_FLOW_JOBS))).toHaveLength(MAX_FLOW_JOBS);
    expect(() => flattenFlow(wide(MAX_FLOW_JOBS + 1))).toThrow(/at most 1000 jobs/);
  });

  test('a deep input is refused by the limit, not by running out of stack', () => {
    expect(() => flattenFlow(chain(200_000))).toThrow(FlowError);
  });

  test('a node used twice, and a cycle, are refused', () => {
    const shared: NewFlowNode = { queue: 'c' };
    expect(() => flattenFlow({ queue: 'r', children: [shared, shared] })).toThrow(/more than once/);
    const loop: { queue: string; children: NewFlowNode[] } = { queue: 'r', children: [] };
    loop.children.push(loop);
    expect(() => flattenFlow(loop)).toThrow(/more than once/);
  });

  test('a custom id used by two jobs is refused', () => {
    expect(() =>
      flattenFlow({
        queue: 'r',
        options: { jobId: 'same' },
        children: [{ queue: 'c', options: { jobId: 'same' } }],
      })
    ).toThrow(/used by two jobs/);
  });

  test('a custom id with a colon is refused', () => {
    expect(() =>
      flattenFlow({ queue: 'r', children: [{ queue: 'c', options: { jobId: 'a:b' } }] })
    ).toThrow(/":"/);
  });

  test('a policy on the root, deduplication, a grouped parent and a removeOnFail child with no policy are refused', () => {
    expect(() => flattenFlow({ queue: 'r', options: { failParentOnFailure: true } })).toThrow(
      /root/
    );
    expect(() =>
      flattenFlow({
        queue: 'r',
        children: [{ queue: 'c', options: { deduplication: { id: 'x' } } }],
      })
    ).toThrow(/deduplication/);
    expect(() =>
      flattenFlow({ queue: 'r', options: { group: { id: 'g' } }, children: [{ queue: 'c' }] })
    ).toThrow(/group/);
    expect(() =>
      flattenFlow({ queue: 'r', children: [{ queue: 'c', options: { removeOnFail: true } }] })
    ).toThrow(/needs a failure policy/);
    expect(
      flattenFlow({
        queue: 'r',
        children: [
          { queue: 'c', options: { removeOnFail: true, removeDependencyOnFailure: true } },
        ],
      })
    ).toHaveLength(2);
  });

  test('malformed nodes are refused with FlowError', () => {
    expect(() => flattenFlow(null as never)).toThrow(FlowError);
    expect(() => flattenFlow({ queue: 7 } as never)).toThrow(FlowError);
    expect(() => flattenFlow({ queue: 'r', children: 'no' } as never)).toThrow(FlowError);
    expect(() => flattenFlow({ queue: 'r', children: [5] } as never)).toThrow(FlowError);
  });
});
