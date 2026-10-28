import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusBadge';
import { Table, TableScroll, Td, Th, THead, Tr } from '@/components/ui/Table';
import type { DlqEntryFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/format';
import { useFirstLoad } from '@/lib/useFirstLoad';

/** A flow member goes back through its flow, never alone: the server refuses it (409 `flow_member`). */
const inFlow = (entry: DlqEntryFull) => entry.job.parentId != null || entry.job.flowRoot != null;

export function DlqProTable({
  entries,
  expanded,
  onToggle,
  onRetry,
  retrying,
}: {
  entries: DlqEntryFull[];
  expanded: Set<string>;
  onToggle: (key: string) => void;
  /** Absent when the caller may not retry or the server has closed it: the column is left out. */
  onRetry?: (entry: DlqEntryFull) => void;
  /** The id of the job being retried now. */
  retrying?: string | null;
}) {
  // The rows of the first load rise in a stagger; a row a poll adds later does not.
  const first = useFirstLoad(entries.length > 0);
  return (
    <TableScroll className="rounded-card border border-line bg-surface">
      <Table>
        <THead>
          <tr>
            <Th>Job ID</Th>
            <Th>Name</Th>
            <Th>Reason</Th>
            <Th>Error</Th>
            <Th right>Entered</Th>
            {onRetry && (
              <Th right>
                <span className="sr-only">Retry</span>
              </Th>
            )}
          </tr>
        </THead>
        <tbody>
          {entries.map((entry, index) => {
            const key = `${entry.job.id}-${entry.enteredAt}`;
            return (
              <Tr key={key} arrive={first ? index : undefined}>
                <Td>
                  <Link
                    to={`/job?id=${encodeURIComponent(entry.job.id)}`}
                    className="font-mono text-xs font-semibold text-link hover:underline"
                  >
                    {entry.job.id}
                  </Link>
                </Td>
                <Td className="font-mono text-xs text-muted">{entry.job.name ?? 'default'}</Td>
                <Td>
                  <StatusPill state="failed">{entry.reason}</StatusPill>
                </Td>
                <Td className="max-w-md text-xs text-danger">
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
                </Td>
                <Td className="text-right text-muted">{formatRelativeTime(entry.enteredAt)}</Td>
                {onRetry && (
                  <Td className="text-right">
                    {inFlow(entry) ? (
                      <span className="text-xs text-muted" title="Retry the flow instead">
                        In a flow<span className="sr-only">: retry the flow instead</span>
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        aria-label={`Retry job ${entry.job.id}`}
                        disabled={retrying != null}
                        onClick={() => onRetry(entry)}
                      >
                        {retrying === entry.job.id ? 'Retrying…' : 'Retry'}
                      </Button>
                    )}
                  </Td>
                )}
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableScroll>
  );
}
