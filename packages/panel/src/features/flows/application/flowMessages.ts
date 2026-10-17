import { BqError } from '@/lib/bq';
import type { FlowActionResult } from '../domain/flowWire';

export interface FlowNotice {
  readonly kind: 'success' | 'error';
  readonly text: string;
  /** The picture the operator acted on is not current: reload it. */
  readonly reload: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What an action did, in a sentence. */
export function describeActionResult(result: FlowActionResult): string {
  const count = result.changes.length;
  switch (result.action) {
    case 'retry-failed':
      return `${plural(count, 'job was', 'jobs were')} put back on its queue. The parent runs when they complete.`;
    case 'promote':
      return 'The parent was released. Its processor reads the failed children as ignored; they stay failed.';
    case 'remove':
      return `The flow was removed: ${plural(count, 'job', 'jobs')} deleted.`;
  }
}

const MESSAGES: Record<string, string> = {
  version_conflict: 'A job changed while you were looking at it, so nothing was changed.',
  flow_changed: 'The flow changed since it was loaded, so nothing was changed.',
  flow_active: 'Jobs of the flow are running, so nothing was removed. Wait for them to finish.',
  flow_not_retryable:
    'Only a failed child that holds a waiting parent back can be retried, so nothing was changed.',
  flow_not_stuck: 'The parent is not stuck, so nothing was changed.',
  flow_too_large: 'The flow has more jobs than one action can cover, so nothing was changed.',
  flow_not_found: 'This flow no longer exists.',
  confirmation_required: 'Confirm the flow root id to remove the flow.',
};

const STALE = new Set([
  'version_conflict',
  'flow_changed',
  'flow_active',
  'flow_not_retryable',
  'flow_not_stuck',
  'flow_not_found',
]);

const NOT_STUCK_REASON: Record<string, string> = {
  not_waiting: 'The parent is not waiting for its children any more.',
  nothing_blocks: 'No failed child holds the parent back any more.',
  children_unfinished:
    'Children that are not failed have not finished: the parent is waiting, not stuck.',
};

/** An action that did not go through, as the operator should read it. */
export function describeActionError(error: unknown): FlowNotice {
  if (!(error instanceof BqError)) {
    const text = error instanceof Error ? error.message : 'The action failed.';
    return { kind: 'error', text, reload: false };
  }
  const code = error.code ?? '';
  const reason = typeof error.details?.reason === 'string' ? error.details.reason : '';
  const known = code === 'flow_not_stuck' ? NOT_STUCK_REASON[reason] : undefined;
  const base = known ?? MESSAGES[code] ?? error.message;
  const text = STALE.has(code) ? `${base} The flow was reloaded.` : base;
  return { kind: 'error', text, reload: STALE.has(code) };
}
