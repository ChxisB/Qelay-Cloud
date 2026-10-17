import { BqError } from '@/lib/bq';
import type { WorkflowActionResult } from '../domain/workflowWire';

export interface WorkflowNotice {
  readonly kind: 'success' | 'error';
  readonly text: string;
  /** The picture the operator acted on is not current: reload it. */
  readonly reload: boolean;
}

/** What an action did, in a sentence. */
export function describeActionResult(result: WorkflowActionResult): string {
  switch (result.action) {
    case 'signal':
      return result.resumed
        ? 'The signal was recorded and the run was put back on its queue.'
        : 'The signal was recorded. The run was not waiting for it, so it will see it at its gate.';
    case 'cancel':
      return result.published
        ? 'The run was cancelled. Its rollback is on its queue and a worker runs it.'
        : 'The run was cancelled.';
    case 'retry-compensation':
      return 'The rollback was put back on its queue.';
    case 'abandon-compensation':
      return 'The rollback was abandoned. The run ends as failed.';
    case 'recover':
      return 'The run was put back on its queue.';
  }
}

const MESSAGES: Record<string, string> = {
  version_conflict: 'The run changed while you were looking at it, so nothing was changed.',
  execution_terminal: 'The run has already finished, so nothing was changed.',
  execution_state: 'This action does not apply to the run in its state, so nothing was changed.',
  workflow_progressing:
    'The run is still making progress, so nothing was changed. Recover applies once it has been idle.',
  signal_rejected: 'The signal was not accepted, so nothing was changed.',
  confirmation_required: 'Type the run id to confirm.',
  execution_not_found: 'This execution no longer exists.',
  publish_failed:
    'The run was changed but its step could not be put on the queue. Use Recover to send it again.',
};

const SIGNAL_REASON: Record<string, string> = {
  duplicate: 'This event was already received by the run.',
  state: 'The run cannot receive signals in its state.',
};

/** The errors that say the page is out of date: the run is read again after them. */
const STALE = new Set([
  'version_conflict',
  'execution_terminal',
  'execution_state',
  'workflow_progressing',
  'execution_not_found',
  'publish_failed',
]);

/** An action that did not go through, as the operator should read it. */
export function describeActionError(error: unknown): WorkflowNotice {
  if (!(error instanceof BqError)) {
    const text = error instanceof Error ? error.message : 'The action failed.';
    return { kind: 'error', text, reload: false };
  }
  const code = error.code ?? '';
  const reason = typeof error.details?.reason === 'string' ? error.details.reason : '';
  const known = code === 'signal_rejected' ? SIGNAL_REASON[reason] : undefined;
  const base = known ?? MESSAGES[code] ?? error.message;
  const text = STALE.has(code) ? `${base} The run was reloaded.` : base;
  return { kind: 'error', text, reload: STALE.has(code) };
}
