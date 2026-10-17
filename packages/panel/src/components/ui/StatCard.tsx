import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * `active` / `waiting` follow the job-state tokens; `green` / `amber` are the semantic
 * success / warning colours (rates, health, thresholds); `red` is the attention tile.
 * Everything else, including brand violet and orange, stays in the text colour.
 */
export type StatTone = 'default' | 'green' | 'red' | 'active' | 'waiting' | 'amber';

const toneClass: Record<StatTone, string> = {
  default: 'text-fg',
  green: 'text-success',
  red: 'text-danger',
  active: 'text-state-active-fg',
  waiting: 'text-state-waiting-fg',
  amber: 'text-warning',
};

export function StatCard({
  label,
  value,
  tone = 'default',
  hint,
  compact,
}: {
  label: string;
  value: ReactNode;
  /** `red` is the attention tile: danger border, a dot beside the label and a danger value. */
  tone?: StatTone;
  hint?: ReactNode;
  compact?: boolean;
}) {
  const attention = tone === 'red';
  return (
    <div
      className={cn(
        'rounded-card border bg-surface',
        attention ? 'border-danger/40' : 'border-line',
        compact ? 'px-4 py-3' : 'px-[18px] py-4'
      )}
    >
      <div className="eyebrow flex items-center gap-2 text-muted">
        {attention && (
          <span className="size-1.5 shrink-0 rounded-full bg-danger-fill" aria-hidden="true" />
        )}
        {label}
      </div>
      <div
        className={cn(
          'mt-2 tnum',
          compact
            ? 'text-xl font-semibold'
            : 'text-[32px] font-bold leading-[1.1] tracking-[-0.03em]',
          toneClass[tone]
        )}
      >
        {value}
      </div>
      {hint != null && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}
