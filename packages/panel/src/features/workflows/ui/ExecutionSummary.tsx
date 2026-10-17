import { Link } from 'react-router-dom';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { isLiveState } from '../domain/workflowDisplay';
import { workflowHref } from '../domain/workflowUrlState';
import type { WorkflowDetail } from '../domain/workflowWire';
import { CompensationView } from './CompensationView';
import { Fact } from './PayloadView';

const linkClass = 'text-link underline';

/** The facts of a run, what it waits for, the runs it started, and how its rollback went. */
export function ExecutionSummary({ detail }: { detail: WorkflowDetail }) {
  const { execution, definition, children, compensation } = detail;
  const live = isLiveState(execution.state);
  const unserved = live && execution.definitionHash !== null && definition?.served !== true;
  const nodes = definition?.graph.length;

  return (
    <div className="space-y-5">
      {unserved && (
        <p role="note" className="rounded-lg border border-warning/30 p-3 text-xs text-warning">
          {definition
            ? 'No worker serves the version of the workflow this run was started with, so it cannot move.'
            : 'No worker ever announced the version of the workflow this run was started with, so it cannot move.'}{' '}
          Start a worker that serves it.
        </p>
      )}
      {execution.failureReason && (
        <p
          role="note"
          className="break-words rounded-lg border border-danger/30 p-3 text-xs text-danger"
        >
          {execution.failureReason}
        </p>
      )}
      <dl className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
        <Fact label="Workflow" value={<span translate="no">{execution.workflowName}</span>} />
        <Fact label="State" value={<StatusBadge status={execution.state} />} />
        <Fact
          label="Position"
          value={
            nodes
              ? `Node ${execution.currentNodeIndex + 1} of ${nodes}`
              : `Node ${execution.currentNodeIndex + 1}`
          }
        />
        <Fact
          label="Version of the run"
          value={<span className="tabular-nums">{execution.version}</span>}
        />
        <Fact label="Created" value={formatDateTime(execution.createdAt)} />
        <Fact
          label="Last change"
          value={`${formatDateTime(execution.updatedAt)} (${formatRelativeTime(execution.updatedAt)} ago)`}
        />
        {execution.wait && (
          <Fact
            label="Waiting for"
            value={
              <>
                <span translate="no">{execution.wait.event}</span>
                {execution.wait.deadlineAt !== null
                  ? `, until ${formatDateTime(execution.wait.deadlineAt)}`
                  : ', no deadline'}
              </>
            }
          />
        )}
        {execution.rollbackStatus && <Fact label="Rollback" value={execution.rollbackStatus} />}
        {execution.committedAt !== null && (
          <Fact label="Passed the pivot" value={`At node ${execution.committedAt + 1}`} />
        )}
        {execution.definitionHash && (
          <Fact
            label="Definition"
            value={
              <span translate="no" className="font-mono">
                {execution.definitionHash.slice(0, 12)}
              </span>
            }
          />
        )}
        {execution.parentExecutionId && (
          <Fact
            label="Started by"
            value={
              <Link to={workflowHref(execution.parentExecutionId)} className={linkClass}>
                <span translate="no">{execution.parentExecutionId}</span>
              </Link>
            }
          />
        )}
      </dl>

      <section aria-label="Signals received">
        <h3 className="mb-2 text-xs font-medium text-fg">
          Signals received ({execution.signals.total})
        </h3>
        {execution.signals.items.length === 0 ? (
          <p className="text-xs text-faint">None.</p>
        ) : (
          <ul className="space-y-1 text-xs text-muted">
            {execution.signals.items.map((signal) => (
              <li key={signal.event} translate="no" className="font-mono">
                {signal.event}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Child executions">
        <h3 className="mb-2 text-xs font-medium text-fg">Child executions ({children.total})</h3>
        {children.items.length === 0 ? (
          <p className="text-xs text-faint">None.</p>
        ) : (
          <ul className="space-y-1 text-xs text-muted">
            {children.items.map((child) => (
              <li key={child.executionId}>
                <span translate="no" className="font-mono">
                  {child.step}
                </span>
                {' → '}
                <Link to={workflowHref(child.executionId)} className={linkClass}>
                  <span translate="no">{child.executionId}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Rollback">
        <h3 className="mb-2 text-xs font-medium text-fg">Rollback</h3>
        <CompensationView compensation={compensation} />
      </section>
    </div>
  );
}
