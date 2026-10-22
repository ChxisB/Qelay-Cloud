import type { DlqConfig, StallConfig } from '@/lib/bqTypes';
import { ConfigLoadError, DlqConfigForm, StallForm } from './ConfigForms';
import type { RunAction } from './queueActionModel';
import { LifecycleCard, LimitsCards } from './QueueActions';
import { UnavailableNote } from './UnavailableNote';

/**
 * Everything that changes how one queue behaves, in the order a person reaches for it: pause it, limit it,
 * decide what a stuck or failed job does, and one note on what this server does not offer. Shared by the
 * queue page's Settings tab and by Queue Control; the caller keys it by queue so a switch starts clean.
 */
export function QueueSettings({
  queue,
  paused,
  busy,
  run,
  stall,
  dlq,
  onStallSaved,
  onRetry,
}: {
  queue: string;
  paused: boolean;
  busy: boolean;
  run: RunAction;
  stall: StallConfig | null;
  dlq: DlqConfig | null;
  onStallSaved: () => void | Promise<void>;
  onRetry: () => void;
}) {
  return (
    <>
      <LifecycleCard queue={queue} paused={paused} busy={busy} run={run} />
      <LimitsCards queue={queue} busy={busy} run={run} />
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {stall ? (
          <StallForm queue={queue} config={stall} onSaved={onStallSaved} />
        ) : (
          <ConfigLoadError title="Stuck job detection" onRetry={onRetry} />
        )}
        {dlq ? (
          <DlqConfigForm config={dlq} />
        ) : (
          <ConfigLoadError title="Failed job handling" onRetry={onRetry} />
        )}
      </div>
      <UnavailableNote />
    </>
  );
}
