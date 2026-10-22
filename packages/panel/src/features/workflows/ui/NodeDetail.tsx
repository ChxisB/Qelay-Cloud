import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatDuration } from '@/lib/format';
import type { Recorded } from '../domain/definitionChain';
import { describeNode, fanOutSummary, hasValue, isFanOut } from '../domain/workflowDisplay';
import type { WorkflowStep } from '../domain/workflowWire';
import { PayloadView } from './PayloadView';

const NOTE = {
  ambiguous:
    "More than one step has this name, so the panel cannot tell which record is this one's. The Steps tab lists them all.",
  missing: 'No step with this name has started.',
  later: 'This step is not on the first page of recorded steps. The Steps tab lists them all.',
} as const;

/** One node of the definition: what it does, and for a step, what the run recorded for it. */
export function NodeDetail({
  index,
  node,
  recorded,
  moreSteps,
}: {
  index: number;
  node: Record<string, unknown>;
  recorded: Recorded | null;
  /** The steps the run sent are only the first page. */
  moreSteps: boolean;
}) {
  const { kind, detail, steps } = describeNode(node);
  return (
    <section
      aria-label={`Node ${index + 1}`}
      className="space-y-3 rounded-card border border-line bg-surface p-4"
    >
      <h3 className="text-[13px] leading-6 font-bold text-fg">
        <span className="tnum text-faint">{index + 1}</span>{' '}
        <span className="capitalize">{kind}</span>
      </h3>
      {detail && <p className="text-[13px] leading-6 text-muted">{detail}</p>}
      {steps.length > 0 && (
        <ul translate="no" className="space-y-0.5 font-mono text-sm text-muted">
          {steps.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      )}
      {recorded?.kind === 'found' && <Outcome step={recorded.step} />}
      {recorded?.kind === 'ambiguous' && <p className="text-sm text-muted">{NOTE.ambiguous}</p>}
      {recorded?.kind === 'missing' && (
        <p className="text-sm text-muted">{moreSteps ? NOTE.later : NOTE.missing}</p>
      )}
    </section>
  );
}

function Outcome({ step }: { step: WorkflowStep }) {
  return (
    <div className="space-y-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
        <StatusBadge status={step.status} />
        {step.attempts !== null && (
          <span>
            {step.attempts} attempt{step.attempts === 1 ? '' : 's'}
          </span>
        )}
        {step.durationMs !== null && <span>Took {formatDuration(step.durationMs)}</span>}
      </div>
      {isFanOut(step) && <p className="text-sm text-muted">{fanOutSummary(step.fanOut)}</p>}
      {step.error && (
        <p className="text-sm break-words text-danger">
          {step.error}
          {step.errorTruncated && (
            <span className="font-semibold text-warning"> (cut at the size limit)</span>
          )}
        </p>
      )}
      {hasValue(step.result) && (
        <PayloadView
          value={step.result}
          truncated={step.resultTruncated}
          label={`Result of ${step.name}`}
        />
      )}
    </div>
  );
}
