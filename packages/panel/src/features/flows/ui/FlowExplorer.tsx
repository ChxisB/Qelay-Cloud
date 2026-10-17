import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useCanOperate } from '@/lib/capabilities/useCapabilities';
import type { FlowNotice } from '../application/flowMessages';
import type { LoadedFlow, useFlowExplorer } from '../application/useFlowExplorer';
import { needsAttention } from '../domain/flowTree';
import type { FlowActionName, FlowActionBody } from '../domain/flowWire';
import { FlowActionsBar } from './FlowActionsBar';
import { FlowNodePanel } from './FlowNodePanel';
import { FlowSummary } from './FlowSummary';
import { FlowTree } from './FlowTree';

type Explorer = ReturnType<typeof useFlowExplorer>;

interface Props {
  explorer: Explorer;
  flow: LoadedFlow;
  pending: FlowActionName | null;
  notice: FlowNotice | null;
  onAction: (body: FlowActionBody) => void;
  onDismissNotice: () => void;
}

/** One flow: what it holds, its tree, the selected job, and the actions an operator has. */
export function FlowExplorer({
  explorer,
  flow,
  pending,
  notice,
  onAction,
  onDismissNotice,
}: Props) {
  const canOperate = useCanOperate();
  const { view, tree } = flow;
  const attention = useMemo(() => view.nodes.filter(needsAttention).length, [view]);
  const selected = explorer.selected;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button size="sm" variant="ghost" onClick={explorer.close}>
          ← All flows
        </Button>
        <span className="text-xs text-faint">Root</span>
        <span translate="no" className="break-all font-mono text-xs text-fg">
          {view.root}
        </span>
      </div>
      {notice && (
        <div
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-xs ${
            notice.kind === 'error'
              ? 'border-danger/40 bg-danger/10 text-danger'
              : 'border-state-completed-fg/40 bg-state-completed-bg text-state-completed-fg'
          }`}
        >
          <span>{notice.text}</span>
          <button type="button" onClick={onDismissNotice} className="shrink-0 underline">
            Dismiss
          </button>
        </div>
      )}
      <Card>
        <FlowSummary
          view={view}
          filter={explorer.filter}
          attentionCount={attention}
          canShowMore={explorer.canShowMore}
          loading={explorer.loading}
          onFilter={explorer.setFilter}
          onShowMore={explorer.showMore}
          onExpandAll={explorer.expandAll}
          onCollapseAll={explorer.collapseAll}
        />
      </Card>
      {canOperate ? (
        <FlowActionsBar view={view} tree={tree} pending={pending} onAction={onAction} />
      ) : (
        <p className="text-xs text-faint">Your role can look at flows but not change them.</p>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          {explorer.rows.length === 0 ? (
            <Card>
              <p className="py-8 text-center text-sm text-muted">
                {explorer.filter === 'attention'
                  ? 'No job of this flow needs attention.'
                  : 'This flow has no jobs to show.'}
              </p>
            </Card>
          ) : (
            <FlowTree
              rows={explorer.rows}
              selectedId={selected?.id ?? null}
              onSelect={explorer.select}
              onToggle={explorer.toggle}
            />
          )}
        </div>
        {selected ? (
          <FlowNodePanel
            view={view}
            tree={tree}
            node={selected}
            canOperate={canOperate}
            pending={pending !== null}
            onSelect={explorer.select}
            onAction={onAction}
          />
        ) : (
          <Card>
            <p className="text-sm text-muted">Select a job to see it.</p>
          </Card>
        )}
      </div>
    </div>
  );
}
