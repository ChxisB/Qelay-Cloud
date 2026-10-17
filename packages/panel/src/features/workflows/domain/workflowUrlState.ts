import { decodedHttpPathError } from '@/lib/upstreamPaths';
import { WORKFLOW_STATES } from './workflowWire';

export type WorkflowStateFilter = (typeof WORKFLOW_STATES)[number];
export type WorkflowTab = 'summary' | 'steps' | 'graph' | 'payloads';
export const WORKFLOW_TABS: ReadonlyArray<{ id: WorkflowTab; label: string }> = [
  { id: 'summary', label: 'Summary' },
  { id: 'steps', label: 'Steps' },
  { id: 'graph', label: 'Definition' },
  { id: 'payloads', label: 'Payloads' },
];
export const WORKFLOW_PAGE_SIZE = 25;
/** The most executions the server lists past: a bigger offset is refused (`offset_too_large`). */
const MAX_OFFSET = 1_000_000;

/** What the address of the page says. Everything an operator can share lives here. */
export interface WorkflowUrlState {
  workflowName: string;
  state: WorkflowStateFilter | '';
  offset: number;
  executionId: string | null;
  tab: WorkflowTab;
}

export type WorkflowUrlPatch = Partial<WorkflowUrlState>;

const STATES = new Set<string>(WORKFLOW_STATES);
const TABS = new Set<string>(WORKFLOW_TABS.map((tab) => tab.id));

export const isWorkflowTab = (value: string | null): value is WorkflowTab =>
  value !== null && TABS.has(value);

export function readWorkflowUrlState(params: URLSearchParams): WorkflowUrlState {
  const rawName = params.get('workflow');
  const rawState = params.get('state');
  const rawExecution = params.get('execution');
  const rawTab = params.get('tab');
  const executionId =
    rawExecution && decodedHttpPathError(rawExecution, 'Workflow execution id') === null
      ? rawExecution
      : null;
  return {
    workflowName: rawName && rawName.length <= 256 ? rawName : '',
    state: rawState && STATES.has(rawState) ? (rawState as WorkflowStateFilter) : '',
    offset: validOffset(params.get('offset')),
    executionId,
    tab: executionId && isWorkflowTab(rawTab) ? rawTab : 'summary',
  };
}

/** The canonical query for a state: defaults left out, so one view has one address. */
export function workflowSearchParams(value: WorkflowUrlState): URLSearchParams {
  const params = new URLSearchParams();
  if (value.workflowName) params.set('workflow', value.workflowName);
  if (value.state) params.set('state', value.state);
  if (value.offset > 0) params.set('offset', String(value.offset));
  if (value.executionId) {
    params.set('execution', value.executionId);
    if (value.tab !== 'summary') params.set('tab', value.tab);
  }
  return params;
}

export function patchWorkflowSearchParams(
  params: URLSearchParams,
  patch: WorkflowUrlPatch
): URLSearchParams {
  return workflowSearchParams({ ...readWorkflowUrlState(params), ...patch });
}

/** The page of one execution: what the Job Inspector and the parent/child links point at. */
export const workflowHref = (executionId: string): string =>
  `/workflows?${new URLSearchParams({ execution: executionId })}`;

function validOffset(raw: string | null): number {
  if (!raw || !/^(0|[1-9]\d*)$/.test(raw)) return 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= MAX_OFFSET
    ? Math.floor(value / WORKFLOW_PAGE_SIZE) * WORKFLOW_PAGE_SIZE
    : 0;
}
