import { useEffect, type KeyboardEvent } from 'react';
import { StatusBadge, StatusPill } from '@/components/ui/StatusBadge';
import {
  FLOW_INDENT_PX,
  FLOW_MAX_INDENT,
  FLOW_ROW_HEIGHT,
  FLOW_ROW_OVERSCAN,
  shortFlowId,
} from '../domain/flowConstants';
import type { FlowRow } from '../domain/flowTree';
import { useVirtualRows } from './useVirtualRows';

/** The element id of a job's line: what the tree names as its active descendant. */
export const flowRowDomId = (id: string): string => `flow-row-${encodeURIComponent(id)}`;

interface Props {
  rows: readonly FlowRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}

/**
 * The jobs of a flow as a tree: only the lines in view are drawn, so a flow of 5,000 jobs costs the same
 * as one of fifty. Arrow keys move, open and close, as in any tree.
 */
export function FlowTree({ rows, selectedId, onSelect, onToggle }: Props) {
  const virtual = useVirtualRows(rows.length, FLOW_ROW_HEIGHT, FLOW_ROW_OVERSCAN);
  const selectedIndex = rows.findIndex((row) => row.node.id === selectedId);
  const { reveal } = virtual;
  useEffect(() => reveal(selectedIndex), [selectedIndex, reveal]);

  const move = (index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (row) onSelect(row.node.id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[selectedIndex];
    switch (event.key) {
      case 'ArrowDown':
        move(selectedIndex + 1);
        break;
      case 'ArrowUp':
        move(selectedIndex < 0 ? 0 : selectedIndex - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(rows.length - 1);
        break;
      case 'ArrowRight':
        if (!row?.hasChildren) return;
        if (!row.expanded) onToggle(row.node.id);
        else move(selectedIndex + 1);
        break;
      case 'ArrowLeft': {
        if (!row) return;
        if (row.expanded) {
          event.preventDefault();
          onToggle(row.node.id);
          return;
        }
        const parent = row.node.parentId;
        const at = parent === null ? -1 : rows.findIndex((r) => r.node.id === parent);
        if (at < 0) return;
        move(at);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  const visible = rows.slice(virtual.start, virtual.end);
  return (
    <div
      ref={virtual.ref}
      role="tree"
      aria-label="Jobs of the flow"
      aria-activedescendant={
        selectedIndex >= 0 ? flowRowDomId(rows[selectedIndex]!.node.id) : undefined
      }
      tabIndex={0}
      onScroll={virtual.onScroll}
      onKeyDown={onKeyDown}
      style={{ maxHeight: 560, height: Math.min(virtual.totalHeight, 560) }}
      className="overflow-auto rounded-card border border-line bg-surface"
    >
      <div style={{ height: virtual.totalHeight, position: 'relative' }}>
        {visible.map((row, offset) => (
          <FlowTreeRow
            key={row.node.id}
            row={row}
            top={(virtual.start + offset) * FLOW_ROW_HEIGHT}
            selected={row.node.id === selectedId}
            onSelect={onSelect}
            onToggle={onToggle}
          />
        ))}
      </div>
    </div>
  );
}

function FlowTreeRow({
  row,
  top,
  selected,
  onSelect,
  onToggle,
}: {
  row: FlowRow;
  top: number;
  selected: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const { node } = row;
  const indent = Math.min(node.depth, FLOW_MAX_INDENT) * FLOW_INDENT_PX;
  return (
    // The tree itself takes the keyboard (aria-activedescendant), so a line is only a mouse target.
    <div
      id={flowRowDomId(node.id)}
      role="treeitem"
      aria-level={node.depth + 1}
      aria-setsize={row.siblings}
      aria-posinset={row.position}
      aria-expanded={row.hasChildren ? row.expanded : undefined}
      aria-selected={selected}
      data-flow-state={node.state}
      tabIndex={-1}
      onClick={() => onSelect(node.id)}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onSelect(node.id);
        }
      }}
      style={{
        position: 'absolute',
        top,
        height: FLOW_ROW_HEIGHT,
        left: 0,
        right: 0,
        paddingLeft: indent + 8,
      }}
      className={`flex cursor-pointer items-center gap-2 border-b border-line pr-3 text-xs ${
        selected ? 'bg-selected shadow-[inset_3px_0_0_var(--hl)]' : 'hover:bg-hover'
      }`}
    >
      <span
        aria-hidden="true"
        onClick={(event) => {
          event.stopPropagation();
          if (row.hasChildren) onToggle(node.id);
        }}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-faint"
      >
        {row.hasChildren ? (row.expanded ? '▾' : '▸') : ''}
      </span>
      {node.removed ? (
        <StatusPill state="waiting">removed</StatusPill>
      ) : (
        <StatusBadge status={node.state} />
      )}
      <span translate="no" title={node.id} className="shrink-0 font-mono text-fg">
        {shortFlowId(node.id)}
      </span>
      <span className="hidden shrink-0 text-muted sm:inline">{node.queue}</span>
      {node.attempts > 0 && <span className="shrink-0 text-faint">×{node.attempts}</span>}
      {node.blocking && <span className="shrink-0 font-bold text-danger">holds parent</span>}
      {row.hasChildren && !row.expanded && (
        <span className="shrink-0 text-faint">{row.childCount} below</span>
      )}
      {node.error && (
        <span title={node.error} className="min-w-0 flex-1 truncate text-danger">
          {node.error}
        </span>
      )}
    </div>
  );
}
