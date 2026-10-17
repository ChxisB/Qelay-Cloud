import { useCallback, useEffect, useState } from 'react';
import { captureServerRequestTarget, type ServerRequestTarget } from '@/lib/bq';
import { usePolledData } from '@/lib/usePolledData';
import { WORKFLOW_PAGE_SIZE, type WorkflowUrlState } from '../domain/workflowUrlState';
import type { WorkflowDetail, WorkflowStepsPage } from '../domain/workflowWire';
import { controlWorkflowRepository } from '../infrastructure/controlWorkflowRepository';
import type { WorkflowRepository, WorkflowStepsQuery } from './WorkflowRepository';

export const STEPS_PAGE_SIZE = 50;
const LIST_REFRESH_MS = 10_000;
const DETAIL_REFRESH_MS = 5_000;

/** The workflows and a page of their executions, kept current. */
export function useWorkflowList(
  query: Pick<WorkflowUrlState, 'workflowName' | 'state' | 'offset'>,
  repository: WorkflowRepository = controlWorkflowRepository,
  paused = false
) {
  return usePolledData(
    (signal) => repository.list({ ...query, limit: WORKFLOW_PAGE_SIZE }, signal),
    [repository, query.workflowName, query.state, query.offset],
    { intervalMs: LIST_REFRESH_MS, paused }
  );
}

/** An execution as it was read, with the connection it was read from: an action is refused if that changed. */
export interface LoadedWorkflow {
  readonly target: ServerRequestTarget;
  readonly detail: WorkflowDetail;
}

/** One execution with the first page of its steps, kept current. */
export function useWorkflowDetail(
  id: string,
  repository: WorkflowRepository = controlWorkflowRepository
) {
  return usePolledData<LoadedWorkflow>(
    async (signal) => {
      const target = captureServerRequestTarget();
      return { target, detail: await repository.detail(id, STEPS_PAGE_SIZE, signal) };
    },
    [repository, id],
    { intervalMs: DETAIL_REFRESH_MS }
  );
}

interface StepsState {
  page: WorkflowStepsPage | null;
  error: Error | null;
  loading: boolean;
}

/**
 * A page of an execution's steps, or of the iterations of one fan-out, read when asked for and not
 * polled: a drill-down is a look at one place, and a long fan-out is not re-read every few seconds.
 * `enabled` false reads nothing.
 */
export function useStepsPage(
  repository: WorkflowRepository,
  id: string,
  query: Omit<WorkflowStepsQuery, 'limit'> & { limit?: number },
  enabled: boolean
) {
  const [state, setState] = useState<StepsState>({ page: null, error: null, loading: enabled });
  const [reloads, setReloads] = useState(0);
  const { iterationOf, status, offset } = query;
  const limit = query.limit ?? STEPS_PAGE_SIZE;

  useEffect(() => {
    void reloads;
    if (!enabled) return;
    const controller = new AbortController();
    setState((previous) => ({ ...previous, error: null, loading: true }));
    repository
      .steps(
        id,
        {
          ...(iterationOf === undefined ? {} : { iterationOf }),
          ...(status ? { status } : {}),
          limit,
          offset,
        },
        controller.signal
      )
      .then(
        (page) => {
          if (!controller.signal.aborted) setState({ page, error: null, loading: false });
        },
        (caught: unknown) => {
          if (controller.signal.aborted) return;
          const error = caught instanceof Error ? caught : new Error('Failed to load steps');
          setState((previous) => ({ ...previous, error, loading: false }));
        }
      );
    return () => controller.abort();
  }, [repository, id, iterationOf, status, offset, limit, enabled, reloads]);

  const reload = useCallback(() => setReloads((count) => count + 1), []);
  return { ...state, reload };
}
