import type { FlowNode } from './flowWire';

/** The jobs of a flow by id and by parent, in the order the server listed them. */
export interface FlowTree {
  readonly byId: ReadonlyMap<string, FlowNode>;
  readonly children: ReadonlyMap<string, readonly FlowNode[]>;
  /** Jobs whose parent is not listed: the root, and any job a cut-short view lost the parent of. */
  readonly tops: readonly FlowNode[];
}

/** One line of the tree as it is drawn. */
export interface FlowRow {
  readonly node: FlowNode;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  /** Children listed in the view. */
  readonly childCount: number;
  /** 1-based place among its siblings, and how many there are: what a screen reader announces. */
  readonly position: number;
  readonly siblings: number;
}

export type FlowFilter = 'all' | 'attention';

/** A job an operator has to look at: it failed, or it holds its parent back. */
export const needsAttention = (node: FlowNode): boolean => node.state === 'failed' || node.blocking;

/** A flow of this many jobs or fewer opens fully; a larger one opens down to what needs attention. */
export const OPEN_ALL_LIMIT = 200;

export function buildFlowTree(nodes: readonly FlowNode[]): FlowTree {
  const byId = new Map<string, FlowNode>();
  for (const node of nodes) byId.set(node.id, node);
  const children = new Map<string, FlowNode[]>();
  const tops: FlowNode[] = [];
  for (const node of nodes) {
    const parent = node.parentId;
    if (parent === null || !byId.has(parent) || parent === node.id) {
      tops.push(node);
      continue;
    }
    const list = children.get(parent);
    if (list) list.push(node);
    else children.set(parent, [node]);
  }
  return { byId, children, tops };
}

/** The ids from the job's parent up to the top of what is listed, nearest first. */
export function ancestorsOf(tree: FlowTree, id: string): string[] {
  const path: string[] = [];
  const seen = new Set<string>([id]);
  let current = tree.byId.get(id)?.parentId ?? null;
  while (current !== null && tree.byId.has(current) && !seen.has(current)) {
    path.push(current);
    seen.add(current);
    current = tree.byId.get(current)?.parentId ?? null;
  }
  return path;
}

/**
 * The jobs open when a flow is first shown: all of a small flow, and for a large one the top and the
 * way down to every failure, so what an operator came for is on screen without a hundred clicks.
 */
export function defaultExpanded(tree: FlowTree): Set<string> {
  const open = new Set<string>();
  if (tree.byId.size <= OPEN_ALL_LIMIT) {
    for (const id of tree.children.keys()) open.add(id);
    return open;
  }
  for (const top of tree.tops) open.add(top.id);
  for (const node of tree.byId.values()) {
    if (needsAttention(node)) for (const id of ancestorsOf(tree, node.id)) open.add(id);
  }
  return open;
}

/**
 * The open set after a reload of the same flow: what the operator had open stays open, a job that was not
 * in the earlier picture opens as it would on a first view, and the way down to `keep` is open.
 */
export function reopenAfterReload(
  previous: ReadonlySet<string>,
  before: FlowTree,
  after: FlowTree,
  keep: string | null
): Set<string> {
  const open = new Set<string>();
  for (const id of previous) if (after.byId.has(id)) open.add(id);
  for (const id of defaultExpanded(after)) if (!before.byId.has(id)) open.add(id);
  if (keep !== null) for (const id of ancestorsOf(after, keep)) open.add(id);
  return open;
}

/** Every job that has children listed. */
export const allParents = (tree: FlowTree): Set<string> => new Set(tree.children.keys());

/**
 * The lines to draw, top level first and each job right below its parent. With the `attention` filter
 * only the jobs that need it are listed, each under the parents that lead to it, all open.
 */
export function flowRows(
  tree: FlowTree,
  expanded: ReadonlySet<string>,
  filter: FlowFilter = 'all'
): FlowRow[] {
  const shown = filter === 'attention' ? attentionSet(tree) : null;
  const keep = (list: readonly FlowNode[]) => (shown ? list.filter((n) => shown.has(n.id)) : list);
  const rows: FlowRow[] = [];
  const stack: Array<{ list: readonly FlowNode[]; index: number }> = [
    { list: keep(tree.tops), index: 0 },
  ];
  while (stack.length > 0) {
    const level = stack[stack.length - 1]!;
    const node = level.list[level.index];
    if (node === undefined) {
      stack.pop();
      continue;
    }
    level.index += 1;
    const kids = keep(tree.children.get(node.id) ?? []);
    const open = kids.length > 0 && (shown !== null || expanded.has(node.id));
    rows.push({
      node,
      hasChildren: kids.length > 0,
      expanded: open,
      childCount: kids.length,
      position: level.index,
      siblings: level.list.length,
    });
    if (open) stack.push({ list: kids, index: 0 });
  }
  return rows;
}

function attentionSet(tree: FlowTree): Set<string> {
  const shown = new Set<string>();
  for (const node of tree.byId.values()) {
    if (!needsAttention(node)) continue;
    shown.add(node.id);
    for (const id of ancestorsOf(tree, node.id)) shown.add(id);
  }
  return shown;
}

/** Jobs by state, for the summary line. */
export function countByState(nodes: readonly FlowNode[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const node of nodes)
    if (!node.removed) counts.set(node.state, (counts.get(node.state) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
