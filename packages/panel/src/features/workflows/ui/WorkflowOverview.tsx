import { Card } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatNumber, formatRelativeTime } from '@/lib/format';
import type { WorkflowStateFilter } from '../domain/workflowUrlState';
import type { WorkflowOverview as Overview } from '../domain/workflowWire';
import { WORKFLOW_STATES } from '../domain/workflowWire';

interface Props {
  workflows: readonly Overview[];
  workflowName: string;
  state: WorkflowStateFilter | '';
  onSelect: (workflowName: string, state: WorkflowStateFilter | '') => void;
}

/** Each workflow with its runs by state and the versions of it that workers announced. */
export function WorkflowOverview({ workflows, workflowName, state, onSelect }: Props) {
  if (workflows.length === 0) return null;
  return (
    <section aria-label="Workflows" className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {workflows.map((workflow) => (
        <Card key={workflow.name} className="min-w-0 space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <button
              type="button"
              aria-pressed={workflowName === workflow.name && state === ''}
              onClick={() => onSelect(workflow.name, '')}
              translate="no"
              className="break-all text-left font-mono text-sm font-semibold text-fg underline decoration-dotted hover:decoration-solid"
            >
              {workflow.name}
            </button>
            <span className="shrink-0 text-xs tabular-nums text-faint">
              {formatNumber(workflow.total)} runs
            </span>
          </div>
          <ul aria-label={`${workflow.name} runs by state`} className="flex flex-wrap gap-2">
            {WORKFLOW_STATES.filter((s) => (workflow.counts[s] ?? 0) > 0).map((s) => (
              <li key={s}>
                <button
                  type="button"
                  aria-pressed={workflowName === workflow.name && state === s}
                  onClick={() => onSelect(workflow.name, s)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-xs hover:border-line-strong"
                >
                  <StatusBadge status={s} />
                  <span className="tabular-nums text-muted">
                    {formatNumber(workflow.counts[s])}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {workflow.warnings.map((warning) => (
            <p
              key={warning.hash}
              role="note"
              className="rounded-lg border border-warning/30 p-2 text-xs text-warning"
            >
              {warning.message}
            </p>
          ))}
          <details>
            <summary className="cursor-pointer text-xs text-faint">
              Versions announced by workers ({workflow.definitions.length})
            </summary>
            <ul className="mt-2 space-y-1 text-xs text-muted">
              {workflow.definitions.map((definition) => (
                <li key={definition.hash} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  <span translate="no" className="font-mono">
                    {definition.hash.slice(0, 12)}
                  </span>
                  <span>{definition.served ? 'served' : 'no worker serves it'}</span>
                  <span className="tabular-nums">{definition.liveRuns} live</span>
                  <span className="text-faint">
                    seen {formatRelativeTime(definition.lastSeenAt)} ago
                  </span>
                </li>
              ))}
              {workflow.definitions.length === 0 && (
                <li className="text-faint">No worker has announced this workflow.</li>
              )}
            </ul>
          </details>
        </Card>
      ))}
    </section>
  );
}
