import type { ServerRequestTarget } from '@/lib/bq';
import type { WorkflowStateFilter } from '../domain/workflowUrlState';
import type {
  WorkflowActionBody,
  WorkflowActionResult,
  WorkflowDetail,
  WorkflowList,
  WorkflowStepsPage,
} from '../domain/workflowWire';

export interface WorkflowListQuery {
  /** Only this workflow (its name); empty for all. */
  workflowName: string;
  state: WorkflowStateFilter | '';
  limit: number;
  offset: number;
}

export interface WorkflowStepsQuery {
  /** The fan-out step whose iterations are wanted; without it, the run's own steps. */
  iterationOf?: string;
  status?: 'pending' | 'running' | 'completed' | 'failed';
  limit: number;
  offset: number;
}

/** What the Workflows page needs from the Control API. */
export interface WorkflowRepository {
  /** The workflows with their counts and definitions, and a page of executions, newest first. */
  list(query: WorkflowListQuery, signal?: AbortSignal): Promise<WorkflowList>;
  /** One execution with a page of its steps. A `BqError` 404 `execution_not_found` when there is none. */
  detail(id: string, stepsLimit: number, signal?: AbortSignal): Promise<WorkflowDetail>;
  /** A page of the steps of an execution, or of the iterations of one of its fan-outs. */
  steps(id: string, query: WorkflowStepsQuery, signal?: AbortSignal): Promise<WorkflowStepsPage>;
  /** One action, applied whole or refused. `target` is the connection the operator was looking at. */
  act(
    target: ServerRequestTarget,
    id: string,
    body: WorkflowActionBody
  ): Promise<WorkflowActionResult>;
}
