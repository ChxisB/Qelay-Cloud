import { Button } from '@/components/ui/Button';
import { StatusPill, stateRole } from '@/components/ui/StatusBadge';
import { Table, TableScroll, Td, Th, THead, Tr } from '@/components/ui/Table';
import type { WebhookDeliveryFull } from '@/lib/bq';
import type { WebhookFull } from '@/lib/bqTypes';
import { formatRelativeTime } from '@/lib/format';
import { attemptSummary, EVENT_WORDS, isOnHold, requestLabel, routeName } from './model';

/**
 * The events of one page. `arrival` says where a row rises as it mounts (`useRowArrivals`): the first load in a
 * stagger, an event a later poll adds once, and nothing for a row that was already there.
 */
export function EventsTable({
  deliveries,
  routes,
  selected,
  arrival,
  onToggle,
}: {
  deliveries: readonly WebhookDeliveryFull[];
  routes: ReadonlyMap<string, WebhookFull>;
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
            <Th>Event</Th>
            <Th>Request</Th>
            <Th>To</Th>
            <Th>Attempts</Th>
            <Th right>When</Th>
          </tr>
        </THead>
        <tbody>
          {deliveries.map((item, index) => {
            const owner = routes.get(item.webhookId);
            const held = isOnHold(item, owner);
            return (
              <Tr
                key={item.id}
                dense
                arrive={arrival(item.id, index)}
                status={item.status === 'failed' ? 'bad' : undefined}
              >
                <Td>
                  <StatusPill state={held ? 'delayed' : stateRole(item.status)}>
                    {held ? 'On hold' : EVENT_WORDS[item.status]}
                  </StatusPill>
                </Td>
                <Td className="font-mono text-[13px]">{item.event}</Td>
                <Td className="max-w-[14rem] truncate font-mono text-[13px]">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-pressed={item.id === selected}
                    aria-label={`Open event ${requestLabel(item)}`}
                    onClick={() => onToggle(item.id)}
                  >
                    {requestLabel(item)}
                  </Button>
                </Td>
                <Td className="max-w-[14rem] truncate font-mono text-[13px] text-muted">
                  {owner ? routeName(owner) : 'removed connection'}
                </Td>
                <Td className="text-[13px] text-muted" title={attemptSummary(item)}>
                  {item.attempts}
                  {item.history.length > 0 && <span className="block">{attemptSummary(item)}</span>}
                </Td>
                <Td className="text-right text-[13px] text-muted">
                  {formatRelativeTime(item.finishedAt ?? item.createdAt)}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableScroll>
  );
}
