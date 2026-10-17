import type { QueueSummaryFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { JOB_STATUSES, type JobStatusFilter, STATE_LABEL, stateCount } from './model';

/**
 * The state filter. These are toggle buttons in a labelled group (the same pattern as
 * `SegmentedControl`), not ARIA tabs: there is one table, and no tab panel to switch.
 */
export function JobStateTabs({
  status,
  counts,
  onStatus,
}: {
  status: JobStatusFilter;
  counts: QueueSummaryFull['counts'] | undefined;
  onStatus: (status: JobStatusFilter) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Job state"
      className="flex gap-1 overflow-x-auto border-b border-line"
    >
      {JOB_STATUSES.map((item) => {
        const active = item === status;
        const count = stateCount(counts, item);
        return (
          <button
            key={item}
            type="button"
            aria-pressed={active}
            onClick={() => onStatus(item)}
            className={cn(
              '-mb-px flex h-10 shrink-0 items-center gap-2 border-b-2 px-3.5 text-[13px] transition-colors',
              'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
              active
                ? 'border-ring font-semibold text-fg'
                : 'border-transparent font-medium text-muted hover:text-fg'
            )}
          >
            {STATE_LABEL[item]}
            {count != null && (
              <span
                className={cn(
                  'rounded-full px-[7px] py-px text-[11px] font-semibold tnum',
                  active ? 'bg-selected text-link' : 'bg-surface-2 text-muted'
                )}
              >
                {formatNumber(count)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
