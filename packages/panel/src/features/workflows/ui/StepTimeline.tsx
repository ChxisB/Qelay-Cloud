import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorState, LoadingState } from '@/components/ui/feedback';
import { Pagination } from '@/components/ui/Pagination';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatDateTime, formatDuration } from '@/lib/format';
import { useStepsPage } from '../application/useWorkflowData';
import type { WorkflowRepository } from '../application/WorkflowRepository';
import { hasValue, isFanOut } from '../domain/workflowDisplay';
import { workflowHref } from '../domain/workflowUrlState';
import type { WorkflowStep, WorkflowStepsPage } from '../domain/workflowWire';
import { FanOutDrillDown } from './FanOutDrillDown';
import { PayloadView } from './PayloadView';

/**
 * The steps of an execution in the order they started, a page at a time. The first page arrives with
 * the execution; later pages are read when asked for. A fan-out is one entry with counts.
 */
export function StepTimeline({
  repository,
  executionId,
  first,
}: {
  repository: WorkflowRepository;
  executionId: string;
  first: WorkflowStepsPage;
}) {
  const [page, setPage] = useState(0);
  const later = useStepsPage(
    repository,
    executionId,
    { offset: page * first.limit, limit: first.limit },
    page > 0
  );
  const shown = page === 0 ? first : later.page;

  if (first.total === 0) return <p className="text-xs text-faint">No step has started yet.</p>;
  return (
    <div className="space-y-3">
      {page > 0 && later.error && <ErrorState error={later.error} onRetry={later.reload} />}
      {page > 0 && later.loading && !later.page && <LoadingState label="Loading steps…" />}
      {shown && (
        <ol aria-label={`Steps, page ${page + 1}`} className="space-y-3">
          {shown.items.map((step, index) => (
            <StepItem
              key={step.name}
              repository={repository}
              executionId={executionId}
              step={step}
              last={index === shown.items.length - 1}
            />
          ))}
        </ol>
      )}
      <Pagination
        page={page}
        pageSize={first.limit}
        total={first.total}
        onPageChange={setPage}
        label="steps"
      />
    </div>
  );
}

function StepItem({
  repository,
  executionId,
  step,
  last,
}: {
  repository: WorkflowRepository;
  executionId: string;
  step: WorkflowStep;
  last: boolean;
}) {
  return (
    <li className="relative grid grid-cols-[18px_1fr] gap-3">
      <div className="flex flex-col items-center" aria-hidden="true">
        <span className="mt-1 size-2.5 rounded-full bg-current text-link" />
        {!last && <span className="mt-1 w-px flex-1 bg-line" />}
      </div>
      <div className="min-w-0 rounded-lg border border-line bg-surface-2 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span translate="no" className="break-all font-mono text-sm font-medium text-fg">
            {step.name}
          </span>
          <StatusBadge status={step.status} />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-faint">
          {step.attempts !== null && (
            <span>
              {step.attempts} attempt{step.attempts === 1 ? '' : 's'}
            </span>
          )}
          {step.startedAt !== null && <span>Started {formatDateTime(step.startedAt)}</span>}
          {step.durationMs !== null && <span>Took {formatDuration(step.durationMs)}</span>}
          {step.compensatable && <span>Can be rolled back</span>}
          {step.childExecutionId && (
            <Link to={workflowHref(step.childExecutionId)} className="text-link underline">
              Child execution <span translate="no">{step.childExecutionId}</span>
            </Link>
          )}
        </div>
        {step.compensation && (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
            Rollback <StatusBadge status={step.compensation.status} />
            {step.compensation.error && (
              <span className="break-words text-danger">{step.compensation.error}</span>
            )}
          </p>
        )}
        {step.error && (
          <p className="mt-2 break-words text-xs text-danger">
            {step.error}
            {step.errorTruncated && <span className="text-warning"> (cut at the size limit)</span>}
          </p>
        )}
        {isFanOut(step) && (
          <FanOutDrillDown
            repository={repository}
            executionId={executionId}
            step={step}
            fanOut={step.fanOut}
          />
        )}
        {hasValue(step.result) && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-faint">Result</summary>
            <div className="mt-1">
              <PayloadView
                value={step.result}
                truncated={step.resultTruncated}
                label={`Result of ${step.name}`}
              />
            </div>
          </details>
        )}
      </div>
    </li>
  );
}
