import { ConcurrencyCard } from './ConcurrencyCard';
import type { RunAction } from './queueActionModel';
import { RateLimitCard } from './RateLimitCard';

/** The two caps on a queue, side by side: how fast it starts jobs and how many run at once. */
export function LimitsCards({
  queue,
  busy,
  run,
}: {
  queue: string;
  busy: boolean;
  run: RunAction;
}) {
  return (
    <div className="mb-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
      <RateLimitCard queue={queue} busy={busy} run={run} />
      <ConcurrencyCard queue={queue} busy={busy} run={run} />
    </div>
  );
}
