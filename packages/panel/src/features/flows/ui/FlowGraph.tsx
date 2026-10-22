import { useEffect, useMemo, useRef, useState } from 'react';
import { Connector, INPUT_REACH } from '@/components/ui/nodegraph/Connector';
import { NODE_ICON } from '@/components/ui/nodegraph/nodeIcons';
import { NodeTile } from '@/components/ui/nodegraph/NodeTile';
import { StatusGlyph, stateRole } from '@/components/ui/StatusBadge';
import { cn } from '@/lib/cn';
import { stagger } from '@/lib/stagger';
import { useChangeFlash } from '@/lib/useChangeFlash';
import { useFirstLoad } from '@/lib/useFirstLoad';
import {
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  GRAPH_TILE,
  shortFlowId,
} from '../domain/flowConstants';
import { type GraphEdge, type GraphNode, layoutFlowGraph } from '../domain/flowGraph';
import { type FlowRow, type FlowTree, needsAttention } from '../domain/flowTree';
import type { FlowNode } from '../domain/flowWire';

interface Props {
  rows: readonly FlowRow[];
  tree: FlowTree;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}

/**
 * The open jobs of a flow as nodes joined by lines, parent on the left and children on the right, drawn as a
 * node editor would. It is for reading: a click selects the job, as in the list, and the chip on a parent
 * opens or closes what is below it. A node carries the state as a shape and a word, never as colour alone.
 */
export function FlowGraph({ rows, tree, selectedId, onSelect, onToggle }: Props) {
  const layout = useMemo(() => layoutFlowGraph(rows, tree), [rows, tree]);
  const byId = useMemo(
    () => new Map(layout.nodes.map((placed) => [placed.row.node.id, placed.row.node])),
    [layout]
  );
  // The jobs of the first load arrive in graph order; one a poll or an expand brings later does not.
  const first = useFirstLoad(layout.nodes.length > 0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current
      ?.querySelector<HTMLElement>('[aria-current="true"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [selectedId]);
  return (
    <div
      ref={box}
      role="group"
      aria-label="Graph of the jobs of the flow"
      className="node-canvas max-h-[560px] overflow-auto rounded-card border border-line p-6"
    >
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
        <svg
          aria-hidden="true"
          focusable="false"
          width={layout.width}
          height={layout.height}
          className="absolute left-0 top-0"
        >
          {layout.edges.map((edge) => (
            <EdgeLine key={edge.id} edge={edge} child={byId.get(edge.to)!} first={first} />
          ))}
        </svg>
        {layout.nodes.map((placed) => (
          <GraphBox
            key={placed.row.node.id}
            placed={placed}
            first={first}
            selected={placed.row.node.id === selectedId}
            onSelect={onSelect}
            onToggle={onToggle}
          />
        ))}
      </div>
    </div>
  );
}

/** The line to a child: drawn in with the first load, and again when the child's state really changes. */
function EdgeLine({ edge, child, first }: { edge: GraphEdge; child: FlowNode; first: boolean }) {
  const [place] = useState(first ? child.depth : undefined);
  const pulse = useChangeFlash(child.removed ? 'removed' : child.state);
  return (
    <Connector
      x1={edge.x1}
      y1={edge.y1}
      x2={edge.x2 - INPUT_REACH}
      y2={edge.y2}
      danger={edge.stuck}
      index={pulse > 0 ? undefined : place}
      pulse={pulse}
    />
  );
}

function GraphBox({
  placed,
  first,
  selected,
  onSelect,
  onToggle,
}: {
  placed: GraphNode;
  first: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const { row, waitingOn } = placed;
  const { node } = row;
  const state = node.removed ? 'removed' : node.state.replace(/-/g, ' ');
  // Read once, at mount: dropping the class later would cut the rise short.
  const [place] = useState(first ? node.depth : undefined);
  const flash = useChangeFlash(state);
  const notes = [
    node.blocking && 'Holds parent',
    waitingOn > 0 && `Waiting on ${waitingOn}`,
    node.attempts > 1 && `${node.attempts} tries`,
  ].filter(Boolean);
  const label = `${state} job ${shortFlowId(node.id)} in ${node.queue}${
    notes.length > 0 ? `, ${notes.join(', ')}` : ''
  }`;
  return (
    <div
      data-flow-state={node.state}
      title={node.error ?? undefined}
      className={cn('absolute', place !== undefined && 'motion-arrive')}
      style={{
        left: placed.x,
        top: placed.y,
        width: GRAPH_NODE_WIDTH,
        height: GRAPH_NODE_HEIGHT,
        ...(place === undefined ? {} : stagger(place)),
      }}
    >
      <NodeTile
        tile={GRAPH_TILE}
        width={GRAPH_NODE_WIDTH}
        icon={NODE_ICON.job}
        trigger={node.depth === 0}
        output={row.hasChildren}
        selected={selected}
        danger={needsAttention(node)}
        aria-current={selected ? 'true' : undefined}
        aria-label={label}
        onClick={() => onSelect(node.id)}
        badge={<StatusGlyph state={node.removed ? 'waiting' : stateRole(node.state)} small />}
        title={node.queue}
        sub={
          <span key={flash} className={cn('capitalize', flash > 0 && 'motion-flash')}>
            {state}
          </span>
        }
        note={
          <>
            <span translate="no" className="block truncate font-mono">
              {shortFlowId(node.id)}
            </span>
            {notes.length > 0 && (
              <span className={cn('block truncate', node.blocking && 'font-semibold text-danger')}>
                {notes.join(' · ')}
              </span>
            )}
          </>
        }
      />
      {row.hasChildren && (
        <button
          type="button"
          aria-expanded={row.expanded}
          aria-label={`${row.expanded ? 'Hide' : 'Show'} the ${row.childCount} ${
            row.childCount === 1 ? 'job' : 'jobs'
          } below ${shortFlowId(node.id)}`}
          onClick={() => onToggle(node.id)}
          style={{ left: (GRAPH_NODE_WIDTH + GRAPH_TILE) / 2 + 22, top: GRAPH_TILE / 2 }}
          className="absolute flex h-5 min-w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-line-strong bg-surface px-1 text-xs font-semibold text-fg hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {row.expanded ? '−' : `+${row.childCount}`}
        </button>
      )}
    </div>
  );
}
