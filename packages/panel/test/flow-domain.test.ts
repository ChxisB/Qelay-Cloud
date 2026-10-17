import { describe, expect, test } from 'bun:test';
import {
  promoteAvailability,
  promoteBody,
  removeAvailability,
  removeBody,
  retryAvailability,
  retryBody,
  retryableNodes,
} from '../src/features/flows/domain/flowActions';
import {
  allParents,
  ancestorsOf,
  buildFlowTree,
  countByState,
  defaultExpanded,
  flowRows,
  OPEN_ALL_LIMIT,
  reopenAfterReload,
} from '../src/features/flows/domain/flowTree';
import { flowView, node, stuckFlow, syntheticFlow } from './flow.helpers';

const treeOf = (view = stuckFlow()) => buildFlowTree(view.nodes);

describe('flow tree', () => {
  test('lists each job under its parent, in the order the server gave', () => {
    const tree = treeOf();
    expect(tree.tops.map((n) => n.id)).toEqual(['root']);
    expect(tree.children.get('root')?.map((n) => n.id)).toEqual(['ok', 'bad']);
  });

  test('a job whose parent is not listed, or that names itself, is a top of the tree', () => {
    const tree = buildFlowTree([
      node('lost', { parentId: 'cut-off' }),
      node('self', { parentId: 'self' }),
      node('fine'),
    ]);
    expect(tree.tops.map((n) => n.id)).toEqual(['lost', 'self', 'fine']);
    expect(tree.children.size).toBe(0);
  });

  test('ancestors run from the nearest parent up and stop at a cycle', () => {
    const tree = buildFlowTree([
      node('a', { parentId: 'c' }),
      node('b', { parentId: 'a' }),
      node('c', { parentId: 'b' }),
    ]);
    expect(ancestorsOf(tree, 'a')).toEqual(['c', 'b']);
    expect(ancestorsOf(treeOf(), 'bad')).toEqual(['root']);
    expect(ancestorsOf(treeOf(), 'root')).toEqual([]);
    expect(ancestorsOf(treeOf(), 'missing')).toEqual([]);
  });

  test('rows carry their place among the siblings and what is open', () => {
    const tree = treeOf();
    const rows = flowRows(tree, new Set(['root']));
    expect(
      rows.map((r) => [r.node.id, r.position, r.siblings, r.hasChildren, r.expanded, r.childCount])
    ).toEqual([
      ['root', 1, 1, true, true, 2],
      ['ok', 1, 2, false, false, 0],
      ['bad', 2, 2, false, false, 0],
    ]);
    expect(flowRows(tree, new Set()).map((r) => r.node.id)).toEqual(['root']);
  });

  test('the attention filter keeps the failed and holding jobs under the parents that lead to them', () => {
    const view = flowView([
      node('root', { state: 'waiting-children' }),
      node('mid', { parentId: 'root', depth: 1, state: 'waiting-children' }),
      node('deep', { parentId: 'mid', depth: 2, state: 'failed', blocking: true }),
      node('quiet', { parentId: 'root', depth: 1 }),
    ]);
    const rows = flowRows(buildFlowTree(view.nodes), new Set(), 'attention');
    expect(rows.map((r) => r.node.id)).toEqual(['root', 'mid', 'deep']);
    expect(rows.every((r) => !r.hasChildren || r.expanded)).toBe(true);
  });

  test('a small flow opens fully, a large one down to its failures', () => {
    expect(defaultExpanded(treeOf())).toEqual(new Set(['root']));
    const large = buildFlowTree(syntheticFlow(OPEN_ALL_LIMIT + 1).nodes);
    const open = defaultExpanded(large);
    // The root, and the way down to the one failed leaf: n200 -> n19 -> n1 -> n0.
    expect(open.has('n0')).toBe(true);
    expect(open.has('n1')).toBe(true);
    expect(open.has('n19')).toBe(true);
    expect(open.size).toBe(3);
    expect(allParents(large).size).toBeGreaterThan(open.size);
  });

  test('a reload keeps what was open, opens what is new, and opens the way to the selection', () => {
    const before = buildFlowTree([
      node('r'),
      node('a', { parentId: 'r' }),
      node('x', { parentId: 'a' }),
    ]);
    const after = buildFlowTree([
      node('r'),
      node('a', { parentId: 'r' }),
      node('x', { parentId: 'a' }),
      node('n', { parentId: 'r' }),
      node('m', { parentId: 'n' }),
    ]);
    // The operator had shut `a`; `n` is new, so it opens as it would on a first view.
    const next = reopenAfterReload(new Set(['r']), before, after, null);
    expect(next).toEqual(new Set(['r', 'n']));
    // A selected job inside the shut part is made visible.
    expect(reopenAfterReload(new Set(['r']), before, after, 'x')).toEqual(new Set(['r', 'n', 'a']));
    // A job that is gone is dropped from the open set.
    expect(reopenAfterReload(new Set(['r', 'gone']), before, after, null).has('gone')).toBe(false);
  });

  test('counts jobs by state, most first, and leaves out those removed on completion', () => {
    const counts = countByState([
      node('a'),
      node('b'),
      node('c', { state: 'failed' }),
      node('d', { state: 'waiting' }),
      node('e', { state: 'completed', version: null, removed: true }),
    ]);
    expect(counts).toEqual([
      ['completed', 2],
      ['failed', 1],
      ['waiting', 1],
    ]);
  });
});

describe('flow actions', () => {
  test('only a failed child that holds its parent back can be retried', () => {
    const tree = treeOf();
    expect(retryAvailability(tree, tree.byId.get('bad')!)).toEqual({ ok: true });
    expect(retryAvailability(tree, tree.byId.get('ok')!)).toMatchObject({ ok: false });
    expect(retryAvailability(tree, tree.byId.get('root')!)).toMatchObject({ ok: false });
    expect(retryableNodes(tree).map((n) => n.id)).toEqual(['bad']);
  });

  test('a failed job that does not hold its parent is refused with the reason', () => {
    const tree = buildFlowTree([
      node('r', { state: 'waiting-children' }),
      node('f', { parentId: 'r', state: 'failed', mode: 'ignore', blocking: false }),
    ]);
    const answer = retryAvailability(tree, tree.byId.get('f')!);
    expect(answer).toMatchObject({ ok: false });
    expect(answer.ok === false && answer.reason).toContain('does not hold its parent');
  });

  test('a parent that never ran because its own child failed is not retried from here', () => {
    const tree = buildFlowTree([
      node('top', { state: 'waiting-children' }),
      node('mid', {
        parentId: 'top',
        depth: 1,
        state: 'failed',
        attempts: 0,
        blocking: true,
      }),
      node('leaf', { parentId: 'mid', depth: 2, state: 'failed', blocking: true }),
    ]);
    const answer = retryAvailability(tree, tree.byId.get('mid')!);
    expect(answer.ok === false && answer.reason).toContain('never ran');
    expect(retryAvailability(tree, tree.byId.get('leaf')!)).toEqual({ ok: true });
  });

  test('a job with nothing stored cannot be acted on', () => {
    const tree = buildFlowTree([
      node('r', { state: 'waiting-children' }),
      node('gone', {
        parentId: 'r',
        state: 'failed',
        blocking: true,
        version: null,
        removed: true,
      }),
    ]);
    expect(retryAvailability(tree, tree.byId.get('gone')!)).toMatchObject({ ok: false });
    expect(promoteAvailability(tree, tree.byId.get('r')!)).toEqual({ ok: true });
    expect(promoteBody(tree, tree.byId.get('r')!).jobs.map((j) => j.id)).toEqual(['r']);
  });

  test('a parent is released only when failed children are all that keep it waiting', () => {
    const tree = treeOf();
    expect(promoteAvailability(tree, tree.byId.get('root')!)).toEqual({ ok: true });
    expect(promoteAvailability(tree, tree.byId.get('bad')!)).toMatchObject({ ok: false });

    const running = buildFlowTree([
      node('r', { state: 'waiting-children' }),
      node('f', { parentId: 'r', state: 'failed', blocking: true }),
      node('a', { parentId: 'r', state: 'active' }),
      node('w', { parentId: 'r', state: 'waiting' }),
    ]);
    const answer = promoteAvailability(running, running.byId.get('r')!);
    expect(answer.ok === false && answer.reason).toContain('2 children have not finished');

    const clean = buildFlowTree([
      node('r', { state: 'waiting-children' }),
      node('c', { parentId: 'r' }),
    ]);
    const none = promoteAvailability(clean, clean.byId.get('r')!);
    expect(none.ok === false && none.reason).toBe('No failed child holds it back.');
  });

  test('a flow is removed whole, and not while a job of it runs', () => {
    expect(removeAvailability(stuckFlow())).toEqual({ ok: true });
    const cut = removeAvailability(flowView([node('r')], { truncated: true, total: 9 }));
    expect(cut.ok === false && cut.reason).toContain('Only 1 of 9 jobs are shown');
    const running = removeAvailability(
      flowView([
        node('r', { state: 'waiting-children' }),
        node('a', { parentId: 'r', state: 'active' }),
      ])
    );
    expect(running.ok === false && running.reason).toBe('1 job is running. Wait for it to finish.');
  });

  test('the bodies quote each job at the version the operator saw', () => {
    const view = stuckFlow();
    const tree = buildFlowTree(view.nodes);
    expect(retryBody([tree.byId.get('bad')!])).toEqual({
      action: 'retry-failed',
      jobs: [{ id: 'bad', expectedVersion: 5 }],
    });
    expect(promoteBody(tree, tree.byId.get('root')!)).toEqual({
      action: 'promote',
      jobs: [
        { id: 'root', expectedVersion: 4 },
        { id: 'bad', expectedVersion: 5 },
      ],
      parent: 'root',
    });
    expect(removeBody(view)).toEqual({
      action: 'remove',
      jobs: [
        { id: 'root', expectedVersion: 4 },
        { id: 'ok', expectedVersion: 3 },
        { id: 'bad', expectedVersion: 5 },
      ],
      confirm: 'root',
    });
  });

  test('a job removed on completion has no version to quote and is left out of a removal', () => {
    const view = flowView([
      node('r', { state: 'waiting-children', version: 2 }),
      node('x', { parentId: 'r', version: null, removed: true }),
    ]);
    expect(removeBody(view).jobs).toEqual([{ id: 'r', expectedVersion: 2 }]);
  });
});
