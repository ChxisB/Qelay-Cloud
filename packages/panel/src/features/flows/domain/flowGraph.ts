import {
  GRAPH_COLUMN_GAP,
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  GRAPH_ROW_GAP,
  GRAPH_TILE,
} from './flowConstants';
import { type FlowRow, type FlowTree, needsAttention } from './flowTree';

export interface GraphNode {
  readonly row: FlowRow;
  /** Top left corner of the box. */
  readonly x: number;
  readonly y: number;
  /** Children that have not finished, counted over the whole flow, not just the open boxes. */
  readonly waitingOn: number;
}

export interface GraphEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** The child is failed or holds its parent: the line is drawn in the failure colour. */
  readonly stuck: boolean;
  /** From the right edge of the parent's tile to the left edge of the child's tile, both at the tile's mid height. */
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface FlowGraphLayout {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly width: number;
  readonly height: number;
}

const unfinished = (tree: FlowTree, id: string): number =>
  (tree.children.get(id) ?? []).filter((child) => !child.removed && child.state !== 'completed')
    .length;

/**
 * Lays the open lines of the tree out left to right: a job sits one column right of its parent, every job
 * with nothing open below it gets the next free row, and a parent is centred on its first and last open child.
 * `rows` is what `flowRows` returns, so a parent always comes before its children.
 */
export function layoutFlowGraph(rows: readonly FlowRow[], tree: FlowTree): FlowGraphLayout {
  const index = new Map<string, number>();
  rows.forEach((row, at) => index.set(row.node.id, at));
  const parentAt = rows.map((row) => {
    const parent = row.node.parentId;
    return parent !== null && parent !== row.node.id ? (index.get(parent) ?? -1) : -1;
  });
  const first = new Array<number>(rows.length).fill(-1);
  const last = new Array<number>(rows.length).fill(-1);
  rows.forEach((_, at) => {
    const parent = parentAt[at]!;
    if (parent < 0) return;
    if (first[parent] === -1) first[parent] = at;
    last[parent] = at;
  });

  const column = new Array<number>(rows.length).fill(0);
  const slot = new Array<number>(rows.length).fill(0);
  let next = 0;
  rows.forEach((_, at) => {
    if (parentAt[at]! >= 0) column[at] = column[parentAt[at]!]! + 1;
    if (first[at] === -1) slot[at] = next++;
  });
  // Children come after their parent, so walking back sees every child before its parent.
  for (let at = rows.length - 1; at >= 0; at -= 1) {
    if (first[at] !== -1) slot[at] = (slot[first[at]!]! + slot[last[at]!]!) / 2;
  }

  const x = (at: number) => column[at]! * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP);
  const y = (at: number) => slot[at]! * (GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP);
  const nodes = rows.map((row, at) => ({
    row,
    x: x(at),
    y: y(at),
    waitingOn: unfinished(tree, row.node.id),
  }));
  const edges: GraphEdge[] = [];
  rows.forEach((row, at) => {
    const parent = parentAt[at]!;
    if (parent < 0) return;
    edges.push({
      id: `${rows[parent]!.node.id}>${row.node.id}`,
      from: rows[parent]!.node.id,
      to: row.node.id,
      stuck: needsAttention(row.node),
      x1: x(parent) + (GRAPH_NODE_WIDTH + GRAPH_TILE) / 2,
      y1: y(parent) + GRAPH_TILE / 2,
      x2: x(at) + (GRAPH_NODE_WIDTH - GRAPH_TILE) / 2,
      y2: y(at) + GRAPH_TILE / 2,
    });
  });
  return {
    nodes,
    edges,
    width: Math.max(...column, 0) * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP) + GRAPH_NODE_WIDTH,
    height: Math.max(next, 1) * (GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP) - GRAPH_ROW_GAP,
  };
}
