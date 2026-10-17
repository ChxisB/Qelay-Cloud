import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatDateTime } from '@/lib/format';
import { describeNode } from '../domain/workflowDisplay';
import type { WorkflowDetail } from '../domain/workflowWire';

/**
 * The shape of the workflow this run follows, read from the definition a worker announced, with the
 * node the run is at marked. The panel holds no definition of its own, so a run whose definition no
 * worker announced shows none.
 */
export function DefinitionGraph({
  definition,
  currentNodeIndex,
  live,
}: {
  definition: WorkflowDetail['definition'];
  currentNodeIndex: number;
  /** The run is still going: its cursor is a place, not a count. */
  live: boolean;
}) {
  if (!definition) {
    return (
      <p className="text-xs text-faint">
        No definition is recorded for this run. No worker announced the version it was started with.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
        <div className="flex gap-1">
          <dt className="text-faint">Version</dt>
          <dd translate="no" className="font-mono">
            {definition.hash.slice(0, 12)}
            {definition.revision ? ` · ${definition.revision}` : ''}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-faint">Last announced</dt>
          <dd>{formatDateTime(definition.lastSeenAt)}</dd>
        </div>
        <div>{definition.served ? <StatusBadge status="active" /> : null}</div>
      </dl>
      {!definition.served && (
        <p role="note" className="text-xs text-warning">
          No worker serves this version now. A run on it cannot move until a worker that does is
          started.
        </p>
      )}
      <ol aria-label="Nodes of the workflow" className="space-y-2">
        {definition.graph.map((node, index) => {
          const description = describeNode(node);
          const here = live && index === currentNodeIndex;
          return (
            <li
              key={index}
              aria-current={here ? 'step' : undefined}
              className={`rounded-lg border p-3 text-xs ${here ? 'border-ring bg-selected' : 'border-line bg-surface-2'}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="tabular-nums text-faint">{index + 1}</span>
                <span className="font-medium text-fg">{description.kind}</span>
                {here && <span className="text-link">The run is here</span>}
                {description.detail && <span className="text-muted">{description.detail}</span>}
              </div>
              {description.steps.length > 0 && (
                <ul className="mt-1 space-y-0.5 pl-6 font-mono text-muted" translate="no">
                  {description.steps.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
