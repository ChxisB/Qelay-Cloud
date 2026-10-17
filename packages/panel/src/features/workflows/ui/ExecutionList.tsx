import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/feedback';
import { Pagination } from '@/components/ui/Pagination';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatDateTime, formatNumber } from '@/lib/format';
import { WORKFLOW_PAGE_SIZE } from '../domain/workflowUrlState';
import type { WorkflowList, WorkflowSummary } from '../domain/workflowWire';

interface Props {
  list: WorkflowList;
  filtered: boolean;
  onPage: (offset: number) => void;
  onOpen: (id: string) => void;
}

/** The executions, newest first. */
export function ExecutionList({ list, filtered, onPage, onOpen }: Props) {
  if (list.executions.length === 0 && list.total === 0) {
    return (
      <Card>
        <EmptyState
          title={filtered ? 'No execution matches' : 'No workflow has run yet'}
          hint={
            filtered
              ? 'Change or clear the filters to see more.'
              : 'An execution appears here as soon as a worker starts one.'
          }
        />
      </Card>
    );
  }
  return (
    <Card padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <caption className="sr-only">Workflow executions, newest first</caption>
          <thead className="border-b border-line text-xs text-faint">
            <tr>
              {['Execution', 'Workflow', 'State', 'Node', 'Detail', 'Updated'].map((heading) => (
                <th key={heading} scope="col" className="px-4 py-3 font-medium">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.executions.map((run) => (
              <ExecutionRow key={run.id} run={run} onOpen={onOpen} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-4 pb-4">
        <Pagination
          page={Math.floor(list.offset / WORKFLOW_PAGE_SIZE)}
          pageSize={WORKFLOW_PAGE_SIZE}
          total={list.total}
          onPageChange={(page) => onPage(page * WORKFLOW_PAGE_SIZE)}
          label="executions"
        />
      </div>
    </Card>
  );
}

function ExecutionRow({ run, onOpen }: { run: WorkflowSummary; onOpen: (id: string) => void }) {
  return (
    <tr className="border-b border-line/60 last:border-0 hover:bg-surface-2/60">
      <td className="px-4 py-3">
        <button
          type="button"
          onClick={() => onOpen(run.id)}
          title={run.id}
          className="max-w-[220px] truncate text-left font-mono text-xs text-fg underline decoration-dotted hover:decoration-solid"
        >
          <span translate="no">{run.id}</span>
        </button>
        {run.parentExecutionId && <div className="text-[11px] text-faint">Child run</div>}
      </td>
      <td className="px-4 py-3 text-muted" translate="no">
        {run.workflowName}
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={run.state} />
      </td>
      <td className="px-4 py-3 tabular-nums text-muted">
        {formatNumber(run.currentNodeIndex + 1)}
      </td>
      <td className="max-w-[280px] px-4 py-3 text-xs text-muted">
        {run.wait ? (
          <span>
            Waiting for <span translate="no">{run.wait.event}</span>
            {run.wait.deadlineAt !== null ? `, until ${formatDateTime(run.wait.deadlineAt)}` : ''}
          </span>
        ) : run.failureReason ? (
          <span className="line-clamp-2 break-words text-danger">{run.failureReason}</span>
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-faint">{formatDateTime(run.updatedAt)}</td>
    </tr>
  );
}
