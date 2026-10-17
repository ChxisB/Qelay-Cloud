import { Button } from '@/components/ui/Button';
import { selectionLabel } from './model';

/**
 * Bulk actions for the ticked rows. Promote is the only one offered: Retry and Remove are
 * unavailable by design (see docs/guide/jobs.md, "Unsafe lifecycle transitions fail closed").
 */
export function JobsSelectionBar({
  selectedTotal,
  selectedVisible,
  canPromote,
  bulkBusy,
  onPromote,
  onClear,
}: {
  selectedTotal: number;
  selectedVisible: number;
  canPromote: boolean;
  bulkBusy: boolean;
  onPromote: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 rounded-control border border-ring/35 bg-selected px-3.5 py-2.5">
      <span className="text-[13px] font-semibold tnum">
        {selectionLabel(selectedVisible, selectedTotal)}
      </span>
      <span className="h-[18px] w-px bg-line-strong" aria-hidden="true" />
      {canPromote ? (
        <Button size="sm" disabled={bulkBusy} onClick={onPromote}>
          Promote
        </Button>
      ) : (
        <span className="text-xs text-muted">
          {selectedVisible === 0
            ? 'The selected jobs are hidden by the filter — clear it to act on them.'
            : 'No actions apply to the selected job states.'}
        </span>
      )}
      <Button variant="ghost" size="sm" className="ml-auto" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}
