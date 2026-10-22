import { Figure } from '@/components/ui/Figure';
import { STATE_SOLID, type StateRole } from '@/components/ui/StatusBadge';
import type { QueueSummaryFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { JOB_STATUSES, type JobStatusFilter, STATE_LABEL, stateCount } from './model';

// The tile's swatch. The words and the number carry the meaning, so the swatch is only a cue.
const SWATCH: Partial<Record<JobStatusFilter, StateRole>> = {
  waiting: 'waiting',
  prioritized: 'prioritized',
  active: 'active',
  delayed: 'delayed',
  completed: 'completed',
  failed: 'failed',
};

/**
 * The state filter, as the design's row of counted tiles. These are toggle buttons in a labelled
 * group (the same pattern as `SegmentedControl`), not ARIA tabs: there is one table, and no tab
 * panel to switch.
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
      className="grid grid-cols-[repeat(auto-fit,minmax(min(132px,100%),1fr))] gap-3"
    >
      {JOB_STATUSES.map((item) => {
        const active = item === status;
        const count = stateCount(counts, item);
        const role = SWATCH[item];
        return (
          <button
            key={item}
            type="button"
            aria-pressed={active}
            onClick={() => onStatus(item)}
            className={cn(
              'flex min-h-[72px] flex-col items-start gap-0.5 rounded-[18px] border px-4 py-3.5 text-left transition-colors',
              active ? 'border-hl bg-selected' : 'border-line bg-surface hover:bg-hover'
            )}
          >
            <i
              aria-hidden="true"
              className={cn('mb-1.5 size-2.5 rounded-[3px]', role ? STATE_SOLID[role] : 'bg-idle')}
            />
            <span className="text-[12px] font-semibold text-muted">{STATE_LABEL[item]}</span>
            {count != null && (
              <b className="text-2xl leading-[1.1] font-bold tracking-[-0.02em] text-fg tnum">
                <Figure value={count} />
              </b>
            )}
          </button>
        );
      })}
    </div>
  );
}
