import { Card, CardHeader } from '@/components/ui/Card';
import { bq } from '@/lib/bq';
import { usePolledData } from '@/lib/usePolledData';
import { ConfigLoadError } from './ConfigForms';
import { PolicyForm } from './PolicyForm';
import { RunWindowForm } from './RunWindowForm';

// Both settings change when someone saves them, and the window's open or closed standing moves with the clock.
const POLL = { intervalMs: 30_000 };

function Loading({ title }: { title: string }) {
  return (
    <Card>
      <CardHeader title={title} />
      <p className="text-[13px] text-muted">Loading…</p>
    </Card>
  );
}

/** The queue's retry policy, loaded here so the queue page does not carry it. */
export function QueuePolicyCard({ queue }: { queue: string }) {
  const { data, error, refetch } = usePolledData(
    () => bq.getQueuePolicy(queue).then((response) => ({ policy: response.policy ?? null })),
    [queue],
    POLL
  );
  if (data) return <PolicyForm queue={queue} policy={data.policy} onSaved={refetch} />;
  if (error) return <ConfigLoadError title="Retry policy" onRetry={() => void refetch()} />;
  return <Loading title="Retry policy" />;
}

/** The queue's run window, loaded here for the same reason. */
export function QueueRunWindowCard({ queue }: { queue: string }) {
  const { data, error, refetch } = usePolledData(
    () => bq.getRunWindow(queue).then((response) => ({ window: response.runWindow ?? null })),
    [queue],
    POLL
  );
  if (data) return <RunWindowForm queue={queue} window={data.window} onSaved={refetch} />;
  if (error) return <ConfigLoadError title="Run window" onRetry={() => void refetch()} />;
  return <Loading title="Run window" />;
}
