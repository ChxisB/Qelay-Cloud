import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/feedback';
import { Pagination } from '@/components/ui/Pagination';
import { formatDateTime, formatNumber } from '@/lib/format';
import { FLOW_PAGE_SIZE, flowStateStyle, shortFlowId } from '../domain/flowConstants';
import type { FlowList as FlowListData, FlowRootSummary } from '../domain/flowWire';

interface Props {
  list: FlowListData;
  page: number;
  onPage: (page: number) => void;
  onOpen: (root: string) => void;
}

/** The flows of the namespace, newest first: where an operator starts. */
export function FlowList({ list, page, onPage, onOpen }: Props) {
  if (list.flows.length === 0 && list.total === 0) {
    return (
      <Card>
        <EmptyState
          title="No flows yet"
          hint="A flow is a job with children, added in one call. Flows appear here as soon as one is added."
        />
      </Card>
    );
  }
  return (
    <Card padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <caption className="sr-only">Flows, newest first</caption>
          <thead className="border-b border-line text-xs text-faint">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">
                Flow
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Queue
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                State
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Jobs
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Needs attention
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Created
              </th>
            </tr>
          </thead>
          <tbody>
            {list.flows.map((flow) => (
              <FlowListRow key={flow.id} flow={flow} onOpen={onOpen} />
            ))}
          </tbody>
        </table>
      </div>
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

function FlowListRow({ flow, onOpen }: { flow: FlowRootSummary; onOpen: (root: string) => void }) {
  const failed = flow.states.failed ?? 0;
  return (
    <tr className="border-b border-line/60 last:border-0 hover:bg-surface-2/60">
      <td className="px-4 py-3">
        <button
          type="button"
          onClick={() => onOpen(flow.id)}
          title={flow.id}
          className="text-left font-mono text-xs text-fg underline decoration-dotted hover:decoration-solid"
        >
          <span translate="no">{flow.name ?? shortFlowId(flow.id)}</span>
          <span className="sr-only"> ({flow.id})</span>
        </button>
        {flow.name && (
          <div translate="no" className="font-mono text-[11px] text-faint">
            {shortFlowId(flow.id)}
          </div>
        )}
      </td>
      <td className="px-4 py-3 text-muted">{flow.queue}</td>
      <td className="px-4 py-3">
        <span
          className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${flowStateStyle(flow.state)}`}
        >
          {flow.state}
        </span>
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-muted">{formatNumber(flow.total)}</td>
      <td className="px-4 py-3 text-xs">
        {flow.blocked > 0 ? (
          <span className="rounded border border-danger/40 px-1.5 py-0.5 text-danger">
            {formatNumber(flow.blocked)} stuck
          </span>
        ) : failed > 0 ? (
          <span className="text-warning">{formatNumber(failed)} failed</span>
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-faint">{formatDateTime(flow.createdAt)}</td>
    </tr>
  );
}
