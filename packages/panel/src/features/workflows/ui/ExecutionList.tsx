import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/feedback';
import { Figure } from '@/components/ui/Figure';
import { Pagination } from '@/components/ui/Pagination';
import { StatusBadge, stateRole } from '@/components/ui/StatusBadge';
import { Table, TableScroll, Td, Th, THead, Tr } from '@/components/ui/Table';
import { formatDateTime } from '@/lib/format';
import { useFirstLoad } from '@/lib/useFirstLoad';
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
  // The rows of the first load rise in order; a page or a filter asked for later does not.
  const first = useFirstLoad(list.executions.length > 0);
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
      <TableScroll>
        <Table className="min-w-[720px]">
          <caption className="sr-only">Workflow executions, newest first</caption>
          <THead>
            <tr>
              {['Execution', 'Workflow', 'State', 'Node', 'Detail', 'Updated'].map((heading) => (
                <Th key={heading}>{heading}</Th>
              ))}
            </tr>
          </THead>
          <tbody>
            {list.executions.map((run, index) => (
              <ExecutionRow
                key={run.id}
                run={run}
                arrive={first ? index : undefined}
                onOpen={onOpen}
              />
            ))}
          </tbody>
        </Table>
      </TableScroll>
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

function ExecutionRow({
  run,
  arrive,
  onOpen,
}: {
  run: WorkflowSummary;
  arrive: number | undefined;
  onOpen: (id: string) => void;
}) {
  return (
    <Tr status={stateRole(run.state) === 'failed' ? 'bad' : undefined} arrive={arrive}>
      <Td>
        <button
          type="button"
          onClick={() => onOpen(run.id)}
          title={run.id}
          className="min-h-8 max-w-[220px] truncate rounded-control text-left font-mono text-xs font-bold text-link underline decoration-dotted hover:decoration-solid"
        >
          <span translate="no">{run.id}</span>
        </button>
        {run.parentExecutionId && <div className="text-xs text-faint">Child run</div>}
      </Td>
      <Td className="text-muted" translate="no">
        {run.workflowName}
      </Td>
      <Td>
        <StatusBadge status={run.state} />
      </Td>
      <Td className="tnum text-muted">
        <Figure value={run.currentNodeIndex + 1} />
      </Td>
      <Td className="max-w-[280px] text-xs text-muted">
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
      </Td>
      <Td className="text-xs text-muted">{formatDateTime(run.updatedAt)}</Td>
    </Tr>
  );
}
