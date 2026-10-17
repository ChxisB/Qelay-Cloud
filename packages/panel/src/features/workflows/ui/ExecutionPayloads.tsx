import type { WorkflowExecution } from '../domain/workflowWire';
import { PayloadView } from './PayloadView';

/**
 * The data a run carries: what it was started with, what it produced and the signals it received.
 * The server cuts each to a size limit and says so. Everyone who can open this page sees it.
 */
export function ExecutionPayloads({ execution }: { execution: WorkflowExecution }) {
  return (
    <div className="space-y-5">
      <p className="text-xs text-faint">
        These values are shown to everyone who can open this page. Large values are cut at a size
        limit.
      </p>
      <section aria-label="Input" className="space-y-1">
        <h3 className="text-xs font-medium text-fg">Input</h3>
        <PayloadView value={execution.input} truncated={execution.inputTruncated} label="Input" />
      </section>
      <section aria-label="Output" className="space-y-1">
        <h3 className="text-xs font-medium text-fg">
          Output
          {execution.output ? (
            <>
              {' '}
              of{' '}
              <span translate="no" className="font-mono">
                {execution.output.step}
              </span>
            </>
          ) : (
            ''
          )}
        </h3>
        <PayloadView
          value={execution.output?.result}
          truncated={execution.output?.truncated}
          empty="No step has produced a result yet."
          label="Output"
        />
      </section>
      <section aria-label="Signal payloads" className="space-y-2">
        <h3 className="text-xs font-medium text-fg">Signals ({execution.signals.total})</h3>
        {execution.signals.items.length === 0 && <p className="text-xs text-faint">None.</p>}
        {execution.signals.items.map((signal) => (
          <div key={signal.event} className="space-y-1">
            <div translate="no" className="font-mono text-xs text-muted">
              {signal.event}
            </div>
            <PayloadView
              value={signal.payload}
              truncated={signal.truncated}
              empty="No data"
              label={`Payload of ${signal.event}`}
            />
          </div>
        ))}
        {execution.signals.total > execution.signals.items.length && (
          <p className="text-xs text-faint">
            {execution.signals.total - execution.signals.items.length} more not shown.
          </p>
        )}
      </section>
    </div>
  );
}
