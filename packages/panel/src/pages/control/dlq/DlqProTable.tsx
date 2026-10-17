import { Link } from 'react-router-dom';
import { IconButton } from '@/components/ui/Button';
import { IconRefresh } from '@/components/ui/icons';
import type { DlqEntryFull } from '@/lib/bqTypes';
import { useDlqMutations } from '@/lib/capabilities/useCapabilities';
import { cn } from '@/lib/cn';
import { FLOW_BULK_RETRY_UNAVAILABLE } from '@/lib/flowMutationSafety';
import { formatRelativeTime } from '@/lib/format';

export function DlqProTable({
  entries,
  expanded,
  onToggle,
}: {
  entries: DlqEntryFull[];
  expanded: Set<string>;
  onToggle: (key: string) => void;
}) {
  const mutations = useDlqMutations();
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left eyebrow text-muted light:bg-surface-2">
            <th className="px-4 py-2.5 font-semibold">Job ID</th>
            <th className="px-4 py-2.5 font-semibold">Name</th>
            <th className="px-4 py-2.5 font-semibold">Reason</th>
            <th className="px-4 py-2.5 font-semibold">Error</th>
            <th className="px-4 py-2.5 text-right font-semibold">Entered</th>
            <th className="w-16 px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const key = `${entry.job.id}-${entry.enteredAt}`;
            return (
              <tr
                key={key}
                className="border-b border-line last:border-0 align-top hover:bg-surface-2/40"
              >
                <td className="px-4 py-2.5">
                  <Link
                    to={`/job?id=${encodeURIComponent(entry.job.id)}`}
                    className="font-mono text-xs text-link hover:underline"
                  >
                    {entry.job.id}
                  </Link>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted">
                  {entry.job.name ?? 'default'}
                </td>
                <td className="px-4 py-2.5">
                  <span className="rounded-md bg-danger/10 px-2 py-0.5 text-xs text-danger">
                    {entry.reason}
                  </span>
                </td>
                <td className="max-w-md px-4 py-2.5 text-xs text-danger">
                  {entry.error ? (
                    <button
                      type="button"
                      title={entry.error}
                      aria-expanded={expanded.has(key)}
                      onClick={() => onToggle(key)}
                      className={cn(
                        'block w-full break-words text-left',
                        !expanded.has(key) && 'line-clamp-2'
                      )}
                    >
                      {entry.error}
                    </button>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-4 py-2.5 text-right text-faint">
                  {formatRelativeTime(entry.enteredAt)}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {mutations.operator && mutations.retry && (
                    <IconButton
                      aria-label="Retry unavailable"
                      disabled
                      title={FLOW_BULK_RETRY_UNAVAILABLE}
                    >
                      <IconRefresh className="size-3.5" />
                    </IconButton>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
