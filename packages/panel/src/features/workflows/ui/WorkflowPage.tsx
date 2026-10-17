import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { BqError } from '@/lib/bq';
import { useWorkflowList } from '../application/useWorkflowData';
import type { WorkflowRepository } from '../application/WorkflowRepository';
import { controlWorkflowRepository } from '../infrastructure/controlWorkflowRepository';
import { ExecutionDetail } from './ExecutionDetail';
import { ExecutionList } from './ExecutionList';
import { useWorkflowUrlState } from './useWorkflowUrlState';
import { WorkflowFilters } from './WorkflowFilters';
import { WorkflowOverview } from './WorkflowOverview';

const isConnectionFailure = (error: Error): boolean =>
  (error instanceof BqError && error.status === 0) ||
  ['TypeError', 'AbortError', 'TimeoutError'].includes(error.name);

/**
 * Workflow executions: what is running, waiting or stuck, and what an operator can do about it.
 * The page holds no workflow definition and runs no engine; it reads what the Control API shows.
 */
export function WorkflowPage({
  repository = controlWorkflowRepository,
}: {
  repository?: WorkflowRepository;
}) {
  const url = useWorkflowUrlState();
  const {
    data: list,
    error,
    loading,
    refetch,
  } = useWorkflowList(url, repository, url.executionId !== null);
  const [names, setNames] = useState<readonly string[]>([]);

  // The workflows to choose from outlive a filter: a list narrowed to one name still offers the others.
  useEffect(() => {
    if (!list) return;
    setNames((known) => {
      const merged = [...new Set([...known, ...list.workflows.map((w) => w.name)])].sort();
      return merged.length === known.length ? known : merged;
    });
  }, [list]);

  const select = (workflowName: string, state: typeof url.state) =>
    url.update({ workflowName, state, offset: 0, executionId: null });

  return (
    <div>
      <PageHeader
        title="Workflows"
        description="Durable runs of multi-step workflows: find one that is waiting or stuck, and act on it."
        actions={
          <Button size="sm" disabled={loading} onClick={() => void refetch()}>
            Refresh
          </Button>
        }
      />
      <div aria-live="polite">
        {error &&
          (list || isConnectionFailure(error) ? (
            <OfflineBanner
              message={`Could not load workflows — ${error.message}`}
              onRetry={() => void refetch()}
            />
          ) : (
            <ErrorState error={error} onRetry={() => void refetch()} />
          ))}
        {loading && !list && !url.executionId && <LoadingState label="Loading workflows…" />}
      </div>
      {url.executionId ? (
        <ExecutionDetail
          key={url.executionId}
          repository={repository}
          id={url.executionId}
          tab={url.tab}
          onTab={(tab) => url.update({ tab }, true)}
          onClose={() => url.update({ executionId: null })}
        />
      ) : (
        list && (
          <>
            <WorkflowOverview
              workflows={list.workflows}
              workflowName={url.workflowName}
              state={url.state}
              onSelect={select}
            />
            <WorkflowFilters
              names={names}
              workflowName={url.workflowName}
              state={url.state}
              onChange={select}
            />
            <ExecutionList
              list={list}
              filtered={Boolean(url.workflowName || url.state)}
              onPage={(offset) => url.update({ offset })}
              onOpen={(executionId) => url.update({ executionId, tab: 'summary' })}
            />
          </>
        )
      )}
    </div>
  );
}
