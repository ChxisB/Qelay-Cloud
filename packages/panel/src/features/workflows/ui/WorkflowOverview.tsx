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
              className="min-h-8 break-all rounded-control text-left font-mono text-sm font-bold text-link underline decoration-dotted hover:decoration-solid aria-pressed:bg-selected"
            >
              {workflow.name}
            </button>
            <span className="shrink-0 text-[13px] tnum text-muted">
              {formatNumber(workflow.total)} {workflow.total === 1 ? 'run' : 'runs'}
            </span>
          </div>
          <ul aria-label={`${workflow.name} runs by state`} className="flex flex-wrap gap-2">
            {WORKFLOW_STATES.filter((s) => (workflow.counts[s] ?? 0) > 0).map((s) => (
              <li key={s}>
                <button
                  type="button"
                  aria-pressed={workflowName === workflow.name && state === s}
                  onClick={() => onSelect(workflow.name, s)}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-full px-1.5 text-xs hover:bg-hover aria-pressed:bg-selected"
                >
                  <StatusBadge status={s} />
                  <span className="tnum font-bold text-fg">{formatNumber(workflow.counts[s])}</span>
                </button>
              </li>
            ))}
          </ul>
          {workflow.warnings.map((warning) => (
            <p
              key={warning.hash}
              role="note"
              className="rounded-control bg-state-waiting-bg px-3 py-2 text-xs font-semibold text-state-waiting-fg"
            >
              {warning.message}
            </p>
          ))}
          <details>
            <summary className="cursor-pointer text-xs font-bold text-muted">
              Versions announced by workers ({workflow.definitions.length})
            </summary>
            <ul className="mt-2 space-y-1 text-xs text-muted">
              {workflow.definitions.map((definition) => (
                <li key={definition.hash} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  <span translate="no" className="font-mono">
                    {definition.hash.slice(0, 12)}
                  </span>
                  <span>{definition.served ? 'served' : 'no worker serves it'}</span>
                  <span className="tnum">{definition.liveRuns} live</span>
                  <span className="text-muted">
                    seen {formatRelativeTime(definition.lastSeenAt)}
                  </span>
                </li>
              ))}
              {workflow.definitions.length === 0 && (
                <li className="text-muted">No worker has announced this workflow.</li>
              )}
            </ul>
          </details>
        </Card>
      ))}
    </section>
  );
}
