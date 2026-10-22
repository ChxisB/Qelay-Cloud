import { useMemo, useState } from 'react';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SegmentedControl } from '@/components/ui/form';
import { useCanOperate } from '@/lib/capabilities/useCapabilities';
import type { FlowNotice } from '../application/flowMessages';
import type { LoadedFlow, useFlowExplorer } from '../application/useFlowExplorer';
import { GRAPH_NODE_LIMIT } from '../domain/flowConstants';
import { needsAttention } from '../domain/flowTree';
import type { FlowActionName, FlowActionBody } from '../domain/flowWire';
import { FlowActionsBar } from './FlowActionsBar';
import { FlowGraph } from './FlowGraph';
import { FlowNodePanel } from './FlowNodePanel';
import { FlowSummary } from './FlowSummary';
import { FlowTree } from './FlowTree';

type Explorer = ReturnType<typeof useFlowExplorer>;

const VIEWS = ['graph', 'list'] as const;

/** The graph needs width: a phone starts on the list. */
const firstView = (): (typeof VIEWS)[number] =>
  typeof window !== 'undefined' && window.matchMedia?.('(max-width: 767px)').matches
    ? 'list'
    : 'graph';

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
  const [shown, setShown] = useState(firstView);
  const tooBig = explorer.rows.length > GRAPH_NODE_LIMIT;
  const asGraph = shown === 'graph' && !tooBig;
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
        <Banner
          tone={notice.kind === 'error' ? 'problem' : 'ok'}
          title={notice.kind === 'error' ? 'Flow action failed' : 'Flow action done'}
          action={
            <Button size="sm" variant="ghost" onClick={onDismissNotice}>
              Dismiss
            </Button>
          }
        >
          {' '}
          {notice.text}
        </Banner>
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
        <p className="text-[13px] text-muted">Your role can look at flows but not change them.</p>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <SegmentedControl
              label="Show the jobs as"
              options={VIEWS}
              value={shown}
              onChange={setShown}
            />
            {shown === 'graph' && tooBig && (
              <p role="status" className="text-[13px] text-muted">
                {explorer.rows.length} jobs are open, too many to draw, so this is the list. Close
                some, or show only the jobs that need attention, to get the graph back.
              </p>
            )}
          </div>
          {explorer.rows.length === 0 ? (
            <Card>
              <p className="py-6 text-center text-[13px] text-muted">
                {explorer.filter === 'attention'
                  ? 'No job of this flow needs attention.'
                  : 'This flow has no jobs to show.'}
              </p>
            </Card>
          ) : asGraph ? (
            <FlowGraph
              rows={explorer.rows}
              tree={tree}
              selectedId={selected?.id ?? null}
              onSelect={explorer.select}
              onToggle={explorer.toggle}
            />
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
