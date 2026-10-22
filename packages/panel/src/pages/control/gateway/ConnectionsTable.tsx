import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { Table, TableScroll, Th, THead } from '@/components/ui/Table';
import type { WebhookFull } from '@/lib/bqTypes';

/** The Table view: every connection in one flat table, with the source and its rules as columns. */
export function ConnectionsTable({
  routes,
  row,
  trend = false,
}: {
  routes: readonly WebhookFull[];
  row: (route: WebhookFull) => ReactNode;
  /** Whether the rows carry the 24 hour column. */
  trend?: boolean;
}) {
  return (
    <Card padded={false}>
      <TableScroll>
        <Table>
          <THead>
            <tr>
              <Th>Source</Th>
              <Th>Destination</Th>
              <Th>Rules</Th>
              <Th>Events</Th>
              <Th>Status</Th>
              {trend && <Th>Last 24 hours</Th>}
              <Th right>Success / Fail</Th>
              <Th right>Last</Th>
              <Th>On</Th>
              <Th className="w-56">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <tbody>{routes.map(row)}</tbody>
        </Table>
      </TableScroll>
    </Card>
  );
}
