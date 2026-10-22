import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/feedback';
import { Figure } from '@/components/ui/Figure';
import { FlowDrawing } from '@/components/ui/illustrations';
import { Pagination } from '@/components/ui/Pagination';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Table, TableScroll, Td, Th, THead, Tr } from '@/components/ui/Table';
import { formatDateTime, formatNumber } from '@/lib/format';
import { useFirstLoad } from '@/lib/useFirstLoad';
import { FLOW_PAGE_SIZE, shortFlowId } from '../domain/flowConstants';
import type { FlowList as FlowListData, FlowRootSummary } from '../domain/flowWire';

interface Props {
  list: FlowListData;
  page: number;
  onPage: (page: number) => void;
  onOpen: (root: string) => void;
}

/** The flows of the namespace, newest first: where an operator starts. */
export function FlowList({ list, page, onPage, onOpen }: Props) {
  // The rows of the first load rise in order; a page asked for later does not.
  const first = useFirstLoad(list.flows.length > 0);
  if (list.flows.length === 0 && list.total === 0) {
    return (
      <Card>
        <EmptyState
          picture={<FlowDrawing />}
          title="No flows yet"
          hint="A flow is a job with child jobs under it, added in one call, and a parent can wait for its children. Flows appear here as soon as your code adds one."
        />
      </Card>
    );
  }
  return (
    <Card padded={false}>
      <TableScroll>
        <Table className="min-w-[640px]">
          <caption className="sr-only">Flows, newest first</caption>
          <THead>
            <tr>
              <Th>Flow</Th>
              <Th>Queue</Th>
              <Th>State</Th>
              <Th right>Jobs</Th>
              <Th>Needs attention</Th>
              <Th>Created</Th>
            </tr>
          </THead>
          <tbody>
            {list.flows.map((flow, index) => (
              <FlowListRow
                key={flow.id}
                flow={flow}
                arrive={first ? index : undefined}
                onOpen={onOpen}
              />
            ))}
          </tbody>
        </Table>
      </TableScroll>
      <div className="px-4 pb-4">
        <Pagination
          page={page}
          pageSize={FLOW_PAGE_SIZE}
          total={list.total}
          onPageChange={onPage}
          label="flows"
        />
      </div>
    </Card>
  );
}

function FlowListRow({
  flow,
  arrive,
  onOpen,
}: {
  flow: FlowRootSummary;
  arrive: number | undefined;
  onOpen: (root: string) => void;
}) {
  const failed = flow.states.failed ?? 0;
  return (
    <Tr status={flow.blocked > 0 ? 'bad' : undefined} arrive={arrive}>
      <Td>
        <button
          type="button"
          onClick={() => onOpen(flow.id)}
          title={flow.id}
          className="min-h-8 rounded-control text-left font-mono text-xs font-bold text-link underline decoration-dotted hover:decoration-solid"
        >
          <span translate="no">{flow.name ?? shortFlowId(flow.id)}</span>
          <span className="sr-only"> ({flow.id})</span>
        </button>
        {flow.name && (
          <div translate="no" className="font-mono text-xs text-faint">
            {shortFlowId(flow.id)}
          </div>
        )}
      </Td>
      <Td className="text-muted">{flow.queue}</Td>
      <Td>
        <StatusBadge status={flow.state} />
      </Td>
      <Td className="text-right tnum text-muted">
        <Figure value={flow.total} />
      </Td>
      <Td className="text-xs">
        {flow.blocked > 0 ? (
          <span className="font-bold text-danger">{formatNumber(flow.blocked)} stuck</span>
        ) : failed > 0 ? (
          <span className="font-bold text-warning">{formatNumber(failed)} failed</span>
        ) : (
          <span className="text-faint">—</span>
        )}
      </Td>
      <Td className="text-xs text-muted">{formatDateTime(flow.createdAt)}</Td>
    </Tr>
  );
}
