import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useChangeFlash } from '@/lib/useChangeFlash';

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

/**
 * The design's ring motif, one shape per state so colour is never the only signal. Ported
 * from the boards' `qnav.js` (18px grid): completed and failed are filled rings with a mark
 * cut out in the card colour, active is half filled, the rest are outlined with a mark.
 * Waiting, prioritized and delayed take the design's idle, (new) up-arrow and clock shapes;
 * the design's paused and warning shapes have no job-state role here, so they are not ported.
 */
const GLYPH: Record<StateRole, { filled?: boolean; half?: string; mark?: string }> = {
  completed: { filled: true, mark: 'M5.4 9.3l2.4 2.3 4.7-5' },
  failed: { filled: true, mark: 'M6.2 6.2l5.6 5.6M11.8 6.2l-5.6 5.6' },
  active: { half: 'M9 1.4a7.6 7.6 0 0 1 0 15.2z' },
  waiting: { mark: 'M5.8 9h6.4' },
  prioritized: { mark: 'M9 12.4V5.8M6.4 8.4L9 5.8l2.6 2.6' },
  delayed: { mark: 'M9 5v4.2l2.6 1.6' },
};

/** Decorative: always render it beside the state's word, which carries the meaning. */
export function StatusGlyph({ state, small }: { state: StateRole; small?: boolean }) {
  const glyph = GLYPH[state];
  return (
    <svg
      viewBox="0 0 18 18"
      aria-hidden="true"
      focusable="false"
      className={cn('shrink-0', small ? 'size-3.5' : 'size-4', STATE_TEXT[state])}
    >
      <circle
        cx="9"
        cy="9"
        r="8"
        fill={glyph.filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.7"
      />
      {glyph.half && <path d={glyph.half} fill="currentColor" />}
      {glyph.mark && (
        <path
          d={glyph.mark}
          fill="none"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={glyph.filled ? 'stroke-surface' : 'stroke-current'}
        />
      )}
    </svg>
  );
}

/** The design's pill: a tint with a hairline in the state colour, the glyph, then the words. */
export function StatusPill({
  state,
  className,
  children,
}: {
  state: StateRole;
  className?: string;
  children: ReactNode;
}) {
  // A ring goes out once when the state really changes, never on the first draw or an unchanged poll.
  const changed = useChangeFlash(state);
  return (
    <span
      key={changed}
      className={cn(
        'inline-flex min-h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-xs font-semibold ring-1 ring-inset ring-current/40',
        STATE_PILL[state],
        changed > 0 && 'motion-ping',
        className
      )}
    >
      <StatusGlyph state={state} small />
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <StatusPill state={stateRole(status)} className="capitalize">
      {status || 'unknown'}
    </StatusPill>
  );
}

const DOT: Record<'green' | 'amber' | 'red' | 'zinc', string> = {
  green: 'bg-success',
  amber: 'bg-warning',
  red: 'bg-danger-fill',
  zinc: 'bg-idle',
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
