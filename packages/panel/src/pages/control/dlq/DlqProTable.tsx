import { Link } from 'react-router-dom';
import { StatusPill } from '@/components/ui/StatusBadge';
import { Table, TableScroll, Td, Th, THead, Tr } from '@/components/ui/Table';
import type { DlqEntryFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/format';
import { useFirstLoad } from '@/lib/useFirstLoad';

export function DlqProTable({
  entries,
  expanded,
  onToggle,
}: {
  entries: DlqEntryFull[];
  expanded: Set<string>;
  onToggle: (key: string) => void;
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
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableScroll>
  );
}
