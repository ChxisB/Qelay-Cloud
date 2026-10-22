import { Card, CardHeader } from '@/components/ui/Card';
import { Disclosure } from '@/components/ui/Disclosure';
import {
  FLOW_COMPLETED_REQUEUE_UNAVAILABLE,
  FLOW_DELETION_UNAVAILABLE,
} from '@/lib/flowMutationSafety';

/**
 * Says once what this server does not offer for a queue, instead of a disabled form and an orange warning
 * beside every control. The exact reasons stay one click away under "Why?".
 */
export function UnavailableNote() {
  return (
    <Card className="mb-6">
      <CardHeader
        title="Not available on this server"
        sub="Removing jobs in bulk (Drain, Clean and Obliterate) and re-queueing completed jobs are switched off."
      />
      <Disclosure summary="Why?">
        <div className="space-y-2 text-[13px] text-muted">
          <p>
            A job can belong to a flow, a set of jobs that depend on each other. These actions could
            break the links between a flow's jobs, so they stay off.
          </p>
          <p>{FLOW_DELETION_UNAVAILABLE}</p>
          <p>{FLOW_COMPLETED_REQUEUE_UNAVAILABLE}</p>
        </div>
      </Disclosure>
    </Card>
  );
}
