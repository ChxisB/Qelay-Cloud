import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { BqError } from '@/lib/bq';
import { cn } from '@/lib/cn';
import { useWorkflowActions } from '../application/useWorkflowActions';
import { useWorkflowDetail } from '../application/useWorkflowData';
import type { WorkflowRepository } from '../application/WorkflowRepository';
import { isLiveState } from '../domain/workflowDisplay';
import { WORKFLOW_TABS, type WorkflowTab } from '../domain/workflowUrlState';
import { DefinitionGraph } from './DefinitionGraph';
import { ExecutionActions } from './ExecutionActions';
import { ExecutionPayloads } from './ExecutionPayloads';
import { ExecutionSummary } from './ExecutionSummary';
import { StepTimeline } from './StepTimeline';

interface Props {
  repository: WorkflowRepository;
  id: string;
  tab: WorkflowTab;
  onTab: (tab: WorkflowTab) => void;
  onClose: () => void;
}

const isNotFound = (error: Error | null): boolean =>
  error instanceof BqError && error.status === 404 && error.code === 'execution_not_found';

/** One execution: its facts, steps, definition and data, and what an operator can do to it. */
export function ExecutionDetail({ repository, id, tab, onTab, onClose }: Props) {
  const { data, error, loading, refetch } = useWorkflowDetail(id, repository);
  const actions = useWorkflowActions({
    repository,
    executionId: id,
    loaded: data,
    reload: () => void refetch(),
  });

  if (loading && !data) return <LoadingState label="Loading execution…" />;
  if (!data) {
    return isNotFound(error) ? (
      <EmptyState
        title="This execution does not exist"
        hint="It may have been removed by retention, or the id is wrong."
        action={
          <Button size="sm" onClick={onClose}>
            Back to the list
          </Button>
        }
      />
    ) : error ? (
      <ErrorState error={error} onRetry={() => void refetch()} />
    ) : null;
  }

  const { detail } = data;
  const { execution } = detail;
  return (
    <section
      aria-label={`Execution ${execution.id}`}
      className="min-w-0 space-y-4 rounded-lg border border-line bg-surface"
    >
      {error && (
        <OfflineBanner
          message="Execution refresh failed. Showing the last snapshot."
          onRetry={() => void refetch()}
        />
      )}
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-faint">Execution</div>
          <h2 translate="no" className="mt-1 break-all font-mono text-sm font-semibold text-fg">
            {execution.id}
          </h2>
          <div className="mt-1 text-xs text-muted" translate="no">
            {execution.workflowName}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={execution.state} />
          <Button size="sm" variant="ghost" onClick={onClose}>
            Back to the list
          </Button>
        </div>
      </header>
      <div className="px-4">
        <ExecutionActions
          execution={execution}
          pending={actions.pending}
          notice={actions.notice}
          onAction={actions.run}
          onDismissNotice={actions.dismiss}
        />
      </div>
      <nav aria-label="Execution detail" className="flex border-b border-line px-2">
        {WORKFLOW_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={tab === item.id}
            onClick={() => onTab(item.id)}
            className={cn(
              'border-b-2 px-3 py-2 text-xs font-medium',
              tab === item.id
                ? 'border-ring text-fg'
                : 'border-transparent text-faint hover:text-muted'
            )}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="p-4" aria-live="polite">
        {tab === 'summary' && <ExecutionSummary detail={detail} />}
        {tab === 'steps' && (
          <StepTimeline repository={repository} executionId={execution.id} first={detail.steps} />
        )}
        {tab === 'graph' && (
          <DefinitionGraph
            definition={detail.definition}
            currentNodeIndex={execution.currentNodeIndex}
            live={isLiveState(execution.state)}
          />
        )}
        {tab === 'payloads' && <ExecutionPayloads execution={execution} />}
      </div>
    </section>
  );
}
