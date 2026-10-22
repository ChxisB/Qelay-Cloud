import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { StatusPill, stateRole } from '@/components/ui/StatusBadge';
import { formatNumber } from '@/lib/format';
import { countByState, type FlowFilter } from '../domain/flowTree';
import { MAX_FLOW_VIEW_NODES, type FlowView } from '../domain/flowWire';

interface Props {
  view: FlowView;
  filter: FlowFilter;
  attentionCount: number;
  canShowMore: boolean;
  loading: boolean;
  onFilter: (filter: FlowFilter) => void;
  onShowMore: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}

/** What the flow holds, whether all of it is shown, and how to look at the part that matters. */
export function FlowSummary({
  view,
  filter,
  attentionCount,
  canShowMore,
  loading,
  onFilter,
  onShowMore,
  onExpandAll,
  onCollapseAll,
}: Props) {
  const counts = countByState(view.nodes);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted">
          {formatNumber(view.truncated ? view.nodes.length : view.total)}{' '}
          {view.nodes.length === 1 ? 'job' : 'jobs'}
        </span>
        {counts.map(([state, n]) => (
          <StatusPill key={state} state={stateRole(state)} className="capitalize">
            {formatNumber(n)} {state}
          </StatusPill>
        ))}
      </div>
      {view.truncated && (
        <TruncationNotice
          view={view}
          canShowMore={canShowMore}
          loading={loading}
          onShowMore={onShowMore}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={filter === 'attention' ? 'primary' : 'default'}
          aria-pressed={filter === 'attention'}
          onClick={() => onFilter(filter === 'attention' ? 'all' : 'attention')}
        >
          {filter === 'attention'
            ? 'Show all jobs'
            : `Needs attention (${formatNumber(attentionCount)})`}
        </Button>
        {filter === 'all' && (
          <>
            <Button size="sm" variant="ghost" onClick={onExpandAll}>
              Expand all
            </Button>
            <Button size="sm" variant="ghost" onClick={onCollapseAll}>
              Collapse all
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function TruncationNotice({
  view,
  canShowMore,
  loading,
  onShowMore,
}: {
  view: FlowView;
  canShowMore: boolean;
  loading: boolean;
  onShowMore: () => void;
}) {
  return (
    <Banner
      tone="warn"
      title={`Showing ${formatNumber(view.nodes.length)} of ${formatNumber(view.total)} jobs.`}
      action={
        canShowMore && (
          <Button size="sm" disabled={loading} onClick={onShowMore}>
            Show more
          </Button>
        )
      }
    >
      {' '}
      The rest are not listed, so a failure or a stuck parent may be out of sight
      {canShowMore ? '.' : `: a view is limited to ${formatNumber(MAX_FLOW_VIEW_NODES)} jobs.`}
    </Banner>
  );
}
