import { cn } from '@/lib/cn';

/**
 * The six designed job states. Each has a `--state-<name>-{bg,fg}` pair in index.css
 * that already switches per theme, so no `light:` overrides are needed here.
 * Class names are written out in full so Tailwind's scanner can see them.
 */
export type StateRole = 'waiting' | 'prioritized' | 'active' | 'completed' | 'failed' | 'delayed';

export const STATE_PILL: Record<StateRole, string> = {
  waiting: 'bg-state-waiting-bg text-state-waiting-fg',
  prioritized: 'bg-state-prioritized-bg text-state-prioritized-fg',
  active: 'bg-state-active-bg text-state-active-fg',
  completed: 'bg-state-completed-bg text-state-completed-fg',
  failed: 'bg-state-failed-bg text-state-failed-fg',
  delayed: 'bg-state-delayed-bg text-state-delayed-fg',
};

/** Solid dot / bar fill in a state's foreground colour (series, progress bars, status dots). */
export const STATE_SOLID: Record<StateRole, string> = {
  waiting: 'bg-state-waiting-fg',
  prioritized: 'bg-state-prioritized-fg',
  active: 'bg-state-active-fg',
  completed: 'bg-state-completed-fg',
  failed: 'bg-state-failed-fg',
  delayed: 'bg-state-delayed-fg',
};

/** State text colour, for numerals and inline labels. */
export const STATE_TEXT: Record<StateRole, string> = {
  waiting: 'text-state-waiting-fg',
  prioritized: 'text-state-prioritized-fg',
  active: 'text-state-active-fg',
  completed: 'text-state-completed-fg',
  failed: 'text-state-failed-fg',
  delayed: 'text-state-delayed-fg',
};

/**
 * Every status string callers pass (job, queue, workflow, compensation and timeline
 * states) mapped onto one of the six roles. Judgment calls: paused / waiting-children
 * read as waiting (the job is parked, not in trouble); stalled, retry and compensating
 * (a rollback in flight) as delayed (needs a look, not failed yet); running / started
 * as active.
 */
export const STATE_ROLE: Record<string, StateRole> = {
  completed: 'completed',
  active: 'active',
  failed: 'failed',
  waiting: 'waiting',
  prioritized: 'prioritized',
  delayed: 'delayed',
  paused: 'waiting',
  'waiting-children': 'waiting',
  stalled: 'delayed',
  running: 'active',
  compensating: 'delayed',
  'compensation-stuck': 'failed',
  compensated: 'completed',
  // Webhook delivery states.
  sending: 'active',
  delivered: 'completed',
  'compensation-failed': 'failed',
  'compensation-skipped': 'delayed',
  // Timeline event names (JobTimeline).
  enqueued: 'waiting',
  started: 'active',
  finished: 'completed',
  retry: 'delayed',
  cancelled: 'waiting',
};

export function stateRole(status: string): StateRole {
  return STATE_ROLE[(status || '').toLowerCase()] ?? 'waiting';
}

export function StatusBadge({ status }: { status: string }) {
  const cls = STATE_PILL[stateRole(status)];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full py-[3px] pl-2 pr-2.5 text-xs font-medium capitalize',
        cls
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {status || 'unknown'}
    </span>
  );
}

const DOT: Record<'green' | 'amber' | 'red' | 'zinc', string> = {
  green: 'bg-success',
  amber: 'bg-warning',
  red: 'bg-danger-fill',
  zinc: 'bg-state-waiting-fg',
};

/** A small colored dot + label used in headers (e.g. "Active", "Live"). */
export function StatusDot({
  label,
  tone = 'green',
}: {
  label: string;
  tone?: 'green' | 'amber' | 'red' | 'zinc';
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
      <span className={cn('size-1.5 rounded-full', DOT[tone])} />
      {label}
    </span>
  );
}
