import type { WorkflowActionBody, WorkflowActionName, WorkflowExecution } from './workflowWire';
import { WORKFLOW_ACTIONS } from './workflowWire';

export const ACTION_LABELS: Record<WorkflowActionName, string> = {
  signal: 'Send signal',
  cancel: 'Cancel run',
  'retry-compensation': 'Retry rollback',
  'abandon-compensation': 'Abandon rollback',
  recover: 'Recover',
};

export const ACTION_HINTS: Record<WorkflowActionName, string> = {
  signal: 'Delivers the event the run waits for, or records it for a later gate.',
  cancel:
    'Stops the run and rolls back what it did, unless it passed a pivot. A step already running finishes first.',
  'retry-compensation': 'Runs the rollback again from the step that failed.',
  'abandon-compensation':
    'Gives up the rollback. What is not undone stays as it is, and the run ends as failed.',
  recover: 'Puts the run back on its queue when its worker is gone or its signal arrived unseen.',
};

/** The actions that cannot be undone: they ask for the run id to be typed back. */
export const DESTRUCTIVE_ACTIONS: ReadonlySet<WorkflowActionName> = new Set([
  'cancel',
  'abandon-compensation',
]);

const KNOWN = new Set<string>(WORKFLOW_ACTIONS);

/** The actions the server says apply to the run now, in the order it gave, without any this panel has no control for. */
export const offeredActions = (
  execution: Pick<WorkflowExecution, 'actions'>
): WorkflowActionName[] =>
  execution.actions.filter((action): action is WorkflowActionName => KNOWN.has(action));

/** Every body names the version the operator read; the server refuses it if the run moved since. */
export const actionBody = (
  execution: Pick<WorkflowExecution, 'id' | 'version'>,
  action: Exclude<WorkflowActionName, 'signal'>,
  reason?: string
): WorkflowActionBody => ({
  action,
  expectedVersion: execution.version,
  ...(DESTRUCTIVE_ACTIONS.has(action) ? { confirm: execution.id } : {}),
  ...(reason?.trim() ? { reason: reason.trim() } : {}),
});

export type SignalDraft =
  | { ok: true; body: WorkflowActionBody }
  | { ok: false; field: 'event' | 'payload'; error: string };

/**
 * A signal from what was typed: the event name, and the payload as JSON. An empty payload sends none,
 * which is a signal that carries no data (it still counts as received).
 */
export function signalBody(
  execution: Pick<WorkflowExecution, 'version'>,
  event: string,
  payloadText: string
): SignalDraft {
  const name = event.trim();
  if (!name) return { ok: false, field: 'event', error: 'Name the event to signal.' };
  if (name.length > 256) {
    return { ok: false, field: 'event', error: 'The event name must be 256 characters or fewer.' };
  }
  const text = payloadText.trim();
  if (!text) {
    return {
      ok: true,
      body: { action: 'signal', expectedVersion: execution.version, event: name },
    };
  }
  try {
    return {
      ok: true,
      body: {
        action: 'signal',
        expectedVersion: execution.version,
        event: name,
        payload: JSON.parse(text) as unknown,
      },
    };
  } catch {
    return { ok: false, field: 'payload', error: 'The payload must be valid JSON.' };
  }
}
