import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useChangeFlash } from '@/lib/useChangeFlash';
import { Spark } from './Spark';

/**
 * `active` / `waiting` follow the job-state tokens; `green` / `amber` are the semantic
 * success / warning colours (rates, health, thresholds); `red` is the attention tile.
 * Everything else, including brand violet and orange, stays in the text colour.
 */
export type StatTone = 'default' | 'green' | 'red' | 'active' | 'waiting' | 'amber';

export const toneClass: Record<StatTone, string> = {
  default: 'text-fg',
  green: 'text-success',
  red: 'text-danger',
  active: 'text-state-active-fg',
  waiting: 'text-state-waiting-fg',
  amber: 'text-warning',
};

// The sparkline takes the tone's glyph shade; it is decorative, the value carries the number.
const sparkClass: Record<StatTone, string> = {
  default: 'text-hl',
  green: 'text-ok',
  red: 'text-bad',
  active: 'text-active',
  waiting: 'text-warn',
  amber: 'text-warn',
};

/** The design's key-figure tile: a label, one big figure, an optional foot line and trend. */
export function StatCard({
  label,
  value,
  tone = 'default',
  hint,
  compact,
  spark,
  steady,
}: {
  label: string;
  value: ReactNode;
  /** `red` is the attention tile: danger border, a dot beside the label and a danger value. */
  tone?: StatTone;
  hint?: ReactNode;
  compact?: boolean;
  /** Recent values for a trend line under the figure. */
  spark?: readonly number[];
  /** For a figure that moves on every poll (an uptime): it updates without the wash. */
  steady?: boolean;
}) {
  const attention = tone === 'red';
  // Only a plain number or string can be compared; an element is new on every render and would flash on each poll.
  const flash = useChangeFlash(
    typeof value === 'number' || typeof value === 'string' ? value : null
  );
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-1 overflow-hidden rounded-card border bg-surface shadow-panel',
        attention ? 'border-danger/40' : 'border-line',
        compact ? 'px-3 py-2' : 'px-4 py-3'
      )}
    >
      <div className="flex items-center gap-2 text-xs font-medium text-muted">
        {attention && (
          <span className="size-1.5 shrink-0 rounded-full bg-danger-fill" aria-hidden="true" />
        )}
        {label}
      </div>
      <div
        key={flash}
        className={cn(
          'tnum',
          compact
            ? 'text-lg font-semibold'
            : 'text-[22px] font-semibold leading-[1.1] tracking-[-0.02em]',
          toneClass[tone],
          flash > 0 && !steady && 'motion-flash'
        )}
      >
        {value}
      </div>
      {hint != null && <div className="text-xs text-muted">{hint}</div>}
      {spark && <Spark values={spark} className={sparkClass[tone]} />}
    </div>
  );
}
