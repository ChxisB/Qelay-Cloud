import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/feedback';
import { SegmentedControl } from '@/components/ui/form';
import { Pagination } from '@/components/ui/Pagination';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatNumber } from '@/lib/format';
import { useStepsPage } from '../application/useWorkflowData';
import type { WorkflowRepository } from '../application/WorkflowRepository';
import type { WorkflowFanOut, WorkflowStep } from '../domain/workflowWire';
import { PayloadView } from './PayloadView';

const FILTERS = ['all', 'failed', 'running', 'pending', 'completed'] as const;
type Filter = (typeof FILTERS)[number];
const PAGE = 25;

/**
 * The iterations of a fan-out, as counts. The iterations themselves are read a page at a time, only
 * when asked for: a step over ten thousand items is one row until someone looks inside.
 */
export function FanOutDrillDown({
  repository,
  executionId,
  step,
  fanOut,
}: {
  repository: WorkflowRepository;
  executionId: string;
  step: WorkflowStep;
  fanOut: WorkflowFanOut;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(0);
  const iterations = useStepsPage(
    repository,
    executionId,
    {
      iterationOf: step.name,
      ...(filter === 'all' ? {} : { status: filter }),
      limit: PAGE,
      offset: page * PAGE,
    },
    open
  );

  return (
    <div className="mt-2 space-y-2">
      <dl
        aria-label={`Iterations of ${step.name}`}
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted"
      >
        <Count label="Iterations" value={fanOut.iterations} />
        <Count label="Completed" value={fanOut.byStatus.completed} />
        <Count label="Running" value={fanOut.byStatus.running} />
        <Count label="Pending" value={fanOut.byStatus.pending} />
        <Count label="Failed" value={fanOut.byStatus.failed} tone="text-danger" />
        {fanOut.compensation.compensated +
          fanOut.compensation.failed +
          fanOut.compensation.skipped >
          0 && (
          <Count
            label="Rolled back"
            value={fanOut.compensation.compensated}
            note={
              fanOut.compensation.failed > 0
                ? `${formatNumber(fanOut.compensation.failed)} failed`
                : undefined
            }
          />
        )}
      </dl>
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Hide iterations' : `Show iterations (${formatNumber(fanOut.iterations)})`}
      </Button>
      {open && (
        <div className="space-y-2 rounded-lg border border-line p-3">
          <SegmentedControl
            options={FILTERS}
            value={filter}
            label={`Iterations of ${step.name} by status`}
            onChange={(next) => {
              setFilter(next);
              setPage(0);
            }}
          />
          {iterations.error && <ErrorState error={iterations.error} onRetry={iterations.reload} />}
          {iterations.loading && !iterations.page && <LoadingState label="Loading iterations…" />}
          {iterations.page && (
            <>
              <ul
                aria-label={`Iterations of ${step.name}, page ${page + 1}`}
                className="divide-y divide-line/60"
              >
                {iterations.page.items.map((item) => (
                  <li
                    key={item.name}
                    className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2 text-xs"
                  >
                    <span className="w-16 shrink-0 tabular-nums text-faint">
                      #{item.loopIndex ?? '?'}
                    </span>
                    <StatusBadge status={item.status} />
                    <div className="min-w-0 flex-1">
                      {item.loopItem !== undefined && (
                        <PayloadView
                          value={item.loopItem}
                          truncated={item.loopItemTruncated}
                          label={`Item ${item.loopIndex ?? ''}`}
                        />
                      )}
                      {item.error && <p className="mt-1 break-words text-danger">{item.error}</p>}
                    </div>
                  </li>
                ))}
              </ul>
              {iterations.page.items.length === 0 && (
                <p className="text-xs text-faint">No iterations with this status.</p>
              )}
              <Pagination
                page={page}
                pageSize={iterations.page.limit}
                total={iterations.page.total}
                onPageChange={setPage}
                label="iterations"
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Count({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: number;
  tone?: string;
  note?: string | undefined;
}) {
  return (
    <div className="flex gap-1">
      <dt className="text-faint">{label}</dt>
      <dd className={`tabular-nums ${value > 0 && tone ? tone : ''}`}>
        {formatNumber(value)}
        {note ? ` (${note})` : ''}
      </dd>
    </div>
  );
}
