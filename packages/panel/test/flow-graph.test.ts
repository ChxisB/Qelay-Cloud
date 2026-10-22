import { describe, expect, test } from 'bun:test';
import {
  GRAPH_COLUMN_GAP,
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  GRAPH_ROW_GAP,
  GRAPH_TILE,
} from '../src/features/flows/domain/flowConstants';
import { layoutFlowGraph } from '../src/features/flows/domain/flowGraph';
import { buildFlowTree, flowRows } from '../src/features/flows/domain/flowTree';
import type { FlowNode } from '../src/features/flows/domain/flowWire';
import { node, stuckFlow } from './flow.helpers';

const STEP_X = GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP;
const STEP_Y = GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP;

function layout(nodes: FlowNode[], open: string[] = nodes.map((n) => n.id)) {
  const tree = buildFlowTree(nodes);
  return layoutFlowGraph(flowRows(tree, new Set(open)), tree);
}
const at = (drawn: ReturnType<typeof layout>, id: string) =>
  drawn.nodes.find((placed) => placed.row.node.id === id)!;

describe('flow graph layout', () => {
  test('a child sits one column right of its parent and the parent is centred on its children', () => {
    const drawn = layout(stuckFlow().nodes);
    expect([at(drawn, 'root').x, at(drawn, 'root').y]).toEqual([0, STEP_Y / 2]);
    expect([at(drawn, 'ok').x, at(drawn, 'ok').y]).toEqual([STEP_X, 0]);
    expect([at(drawn, 'bad').x, at(drawn, 'bad').y]).toEqual([STEP_X, STEP_Y]);
    expect(drawn.width).toBe(STEP_X + GRAPH_NODE_WIDTH);
    expect(drawn.height).toBe(2 * STEP_Y - GRAPH_ROW_GAP);
  });

  test('a line runs from the right edge of the parent tile to the left edge of the child tile, mid height', () => {
    const drawn = layout(stuckFlow().nodes);
    const edge = drawn.edges.find((e) => e.to === 'bad')!;
    const edgeOfTile = (GRAPH_NODE_WIDTH - GRAPH_TILE) / 2;
    expect([edge.x1, edge.y1]).toEqual([
      GRAPH_NODE_WIDTH - edgeOfTile,
      STEP_Y / 2 + GRAPH_TILE / 2,
    ]);
    expect([edge.x2, edge.y2]).toEqual([STEP_X + edgeOfTile, STEP_Y + GRAPH_TILE / 2]);
  });

  test('only a line to a failed child or one that holds its parent is marked stuck', () => {
    const drawn = layout(stuckFlow().nodes);
    expect(drawn.edges.map((e) => [e.to, e.stuck])).toEqual([
      ['ok', false],
      ['bad', true],
    ]);
  });

  test('a parent counts the children that have not finished, open or not', () => {
    const nodes = stuckFlow().nodes;
    expect(at(layout(nodes), 'root').waitingOn).toBe(1);
    expect(at(layout(nodes), 'ok').waitingOn).toBe(0);
    const shut = layout(nodes, []);
    expect(shut.nodes).toHaveLength(1);
    expect(shut.edges).toHaveLength(0);
    expect(at(shut, 'root').waitingOn).toBe(1);
    expect(at(shut, 'root').row.expanded).toBe(false);
    expect(at(shut, 'root').row.childCount).toBe(2);
  });

  test('a deeper job opens a further column, and a chain stays on one row', () => {
    const drawn = layout([
      node('a'),
      node('b', { parentId: 'a', depth: 1 }),
      node('c', { parentId: 'b', depth: 2 }),
    ]);
    expect(drawn.nodes.map((p) => [p.x / STEP_X, p.y])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
    expect(drawn.height).toBe(GRAPH_NODE_HEIGHT);
  });

  test('every job with nothing open below it gets its own row, and a parent centres on its first and last child', () => {
    const drawn = layout([
      node('root'),
      node('a', { parentId: 'root', depth: 1 }),
      node('a1', { parentId: 'a', depth: 2 }),
      node('a2', { parentId: 'a', depth: 2 }),
      node('b', { parentId: 'root', depth: 1 }),
    ]);
    expect(drawn.nodes.map((p) => [p.row.node.id, p.y / STEP_Y])).toEqual([
      ['root', 1.25],
      ['a', 0.5],
      ['a1', 0],
      ['a2', 1],
      ['b', 2],
    ]);
  });

  test('a job whose parent is not listed starts a column of its own, as an extra top', () => {
    const drawn = layout([node('root'), node('lost', { parentId: 'gone', depth: 3 })]);
    expect(drawn.nodes.map((p) => [p.row.node.id, p.x, p.y / STEP_Y])).toEqual([
      ['root', 0, 0],
      ['lost', 0, 1],
    ]);
    expect(drawn.edges).toHaveLength(0);
  });
});
