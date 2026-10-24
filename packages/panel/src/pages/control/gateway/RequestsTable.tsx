import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusBadge';
import { Table, TableScroll, Td, Th, THead, Tr } from '@/components/ui/Table';
import type { RequestFull } from '@/lib/bq';
import { formatRelativeTime } from '@/lib/format';
import { bytesLine, REQUEST_ROLE, REQUEST_WORDS } from './sourceModel';

/**
 * The requests of one page, newest first. `arrival` says where a row rises as it mounts (`useRowArrivals`).
 * A rejected request shows its cause under the status: it is the one thing a sender wants to know.
 */
export function RequestsTable({
  requests,
  sources,
  selected,
  arrival,
  onToggle,
}: {
  requests: readonly RequestFull[];
  sources: ReadonlyMap<string, string>;
  selected: string | null;
  arrival: (id: string, index: number) => number | undefined;
  onToggle: (id: string) => void;
}) {
  return (
    <TableScroll className="rounded-card border border-line bg-surface">
      <Table>
        <THead>
          <tr>
            <Th>Status</Th>
            <Th>Request</Th>
            <Th>Source</Th>
            <Th>Content</Th>
            <Th right>When</Th>
          </tr>
        </THead>
        <tbody>
          {requests.map((item, index) => (
            <Tr
              key={item.id}
              dense
              arrive={arrival(item.id, index)}
              status={item.status === 'rejected' ? 'bad' : undefined}
            >
              <Td>
                <StatusPill state={REQUEST_ROLE[item.status]}>
                  {REQUEST_WORDS[item.status]}
                </StatusPill>
                {item.cause && (
                  <span className="mt-1 block text-[13px] text-muted">{item.cause}</span>
                )}
              </Td>
              <Td className="font-mono text-[13px]">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-pressed={item.id === selected}
                  aria-label={`Open request ${item.method} ${item.id}`}
                  onClick={() => onToggle(item.id)}
                >
                  {item.method} {item.id}
                </Button>
              </Td>
              <Td className="max-w-[14rem] truncate text-[13px] text-muted">
                {sources.get(item.sourceId) ?? item.sourceId}
              </Td>
              <Td className="text-[13px] text-muted">
                {item.contentType ?? 'no content type'}
                <span className="block">{bytesLine(item.bodyBytes)}</span>
              </Td>
              <Td className="text-right text-[13px] text-muted">
                {formatRelativeTime(item.receivedAt)}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  );
}
