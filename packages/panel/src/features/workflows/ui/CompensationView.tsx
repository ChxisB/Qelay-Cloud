import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatNumber } from '@/lib/format';
import type { WorkflowCompensation } from '../domain/workflowWire';

const STATUS_TEXT: Record<string, string> = {
  none: 'No rollback has run.',
  pending: 'A rollback is waiting to start.',
  running: 'A rollback is running.',
  stuck: 'The rollback stopped at a step it could not undo.',
  completed: 'The rollback finished.',
  'not-applicable': 'The run passed a pivot, so nothing was rolled back.',
};

/** What a run did to undo itself: how many steps it could undo and how it went. */
export function CompensationView({ compensation }: { compensation: WorkflowCompensation }) {
  if (compensation.status === 'none' && compensation.eligible === 0) {
    return <p className="text-xs text-faint">No step of this run can be rolled back.</p>;
  }
  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <StatusBadge
          status={compensation.status === 'stuck' ? 'compensation-stuck' : compensation.status}
        />
        {STATUS_TEXT[compensation.status] ?? compensation.status}
      </p>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <Count label="To undo" value={compensation.eligible} />
        <Count label="Undone" value={compensation.compensated} />
        <Count label="Failed" value={compensation.failed} />
        <Count label="Skipped" value={compensation.skipped} />
      </dl>
      {compensation.failures.length > 0 && (
        <ul aria-label="Steps that could not be undone" className="space-y-1 text-xs">
          {compensation.failures.map((failure) => (
            <li key={failure.step} className="rounded-lg border border-danger/30 p-2">
              <span translate="no" className="font-mono text-fg">
                {failure.step}
              </span>
              {failure.error && <p className="mt-1 break-words text-danger">{failure.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex gap-1">
      <dt className="text-faint">{label}</dt>
      <dd className="tabular-nums">{formatNumber(value)}</dd>
    </div>
  );
}
