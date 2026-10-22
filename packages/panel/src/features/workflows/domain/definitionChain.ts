import { isLiveState, nodeStepNames } from './workflowDisplay';
import type { WorkflowStep } from './workflowWire';

/**
 * A node's cell (a square tile and the words under it, the tile centred), the tile's edge and the space between
 * two cells, in pixels. The line between two nodes runs from tile to tile.
 */
export const CHAIN_NODE_WIDTH = 144;
export const CHAIN_TILE = 72;
export const CHAIN_GAP = 16;
/** How far below the boxes the line back to the first one runs. */
export const RETURN_DEPTH = 36;

export type NodeMark = 'done' | 'current' | 'ahead';

/** The run is undoing its steps, or stopped halfway through doing so. */
export const isRollingBack = (state: string): boolean =>
  state === 'compensating' || state === 'compensation-stuck';

/**
 * Where a node stands for this run. A finished run has done them all. A run that is going forward has done
 * the ones before its cursor. While it rolls back the cursor is the only node worth marking, and a failed run
 * says nothing: the server does not say which node it stopped at.
 */
export function nodeMark(index: number, currentNodeIndex: number, state: string): NodeMark | null {
  if (state === 'completed') return 'done';
  if (state === 'running' || state === 'waiting') {
    return index < currentNodeIndex ? 'done' : index === currentNodeIndex ? 'current' : 'ahead';
  }
  return isLiveState(state) && index === currentNodeIndex ? 'current' : null;
}

/** The dashed line from the node a rollback is at back to the first node, drawn under the row of boxes. */
export function returnPath(
  from: number
): { width: number; height: number; line: string; head: string } | null {
  if (from <= 0) return null;
  const centre = (index: number) => index * (CHAIN_NODE_WIDTH + CHAIN_GAP) + CHAIN_NODE_WIDTH / 2;
  const [a, b, h, r] = [centre(from), centre(0), RETURN_DEPTH, 8];
  return {
    width: centre(from) + CHAIN_NODE_WIDTH / 2,
    height: h + 2,
    line: `M${a} 0V${h - r}Q${a} ${h} ${a - r} ${h}H${b + r}Q${b} ${h} ${b} ${h - r}V6`,
    head: `M${b - 5} 11L${b} 4L${b + 5} 11`,
  };
}

export type Recorded =
  | { kind: 'found'; step: WorkflowStep }
  /** The name is used more than once, in the definition or in the record: the panel cannot tell whose it is. */
  | { kind: 'ambiguous' }
  | { kind: 'missing' };

/**
 * The recorded step that belongs to a node, found by name and only when the name is unambiguous. `null` for
 * a node that is not one step (a wait, a branch, a pivot): there is nothing to look up.
 */
export function recordedFor(
  graph: ReadonlyArray<Record<string, unknown>>,
  index: number,
  steps: readonly WorkflowStep[]
): Recorded | null {
  const names = nodeStepNames(graph[index] ?? {});
  const name = names[0];
  if (names.length !== 1 || name === undefined) return null;
  const inGraph = graph.flatMap(nodeStepNames).filter((other) => other === name).length;
  const recorded = steps.filter((step) => step.name === name);
  if (inGraph > 1 || recorded.length > 1) return { kind: 'ambiguous' };
  const [step] = recorded;
  return step ? { kind: 'found', step } : { kind: 'missing' };
}
