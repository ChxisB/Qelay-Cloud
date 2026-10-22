import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Facts } from '@/components/ui/Facts';
import { StatusPill, stateRole } from '@/components/ui/StatusBadge';
import type { WebhookDeliveryFull } from '@/lib/bq';
import type { WebhookFull } from '@/lib/bqTypes';
import { formatDateTime } from '@/lib/format';
import { AttemptLine } from './AttemptLine';
import { EVENT_WORDS, isOnHold, routeName, sourceLabel } from './model';

/**
 * One event in full: what happened, where it went, and every attempt kept for it, drawn as a line of stops
 * (`AttemptLine`). The store keeps no request body and no response body, so there is none to show.
 */
export function EventDetail({
  delivery,
  route,
  busy,
  onRetry,
  onClose,
}: {
  delivery: WebhookDeliveryFull;
  route: WebhookFull | undefined;
  busy: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
  const held = isOnHold(delivery, route);
  return (
    <section aria-label="Event details">
      <Card className="min-w-0">
        <CardHeader
          title="Event"
          headingLevel={3}
          action={
            <Button size="sm" onClick={onClose}>
              Close
            </Button>
          }
        />
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <StatusPill state={held ? 'delayed' : stateRole(delivery.status)}>
            {held ? 'On hold' : EVENT_WORDS[delivery.status]}
          </StatusPill>
          {delivery.status === 'failed' && (
            <Button size="sm" disabled={busy} onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
        {held && (
          <div className="mb-3">
            <Banner tone="warn" title="On hold">
              The connection is off, so this event waits. Turn it on to send it.
            </Banner>
          </div>
        )}
        <Facts
          items={[
            { label: 'Event', value: delivery.event },
            { label: 'Job', value: `${delivery.queue} / ${delivery.jobId}` },
            { label: 'From', value: route ? sourceLabel(route) : `Qelay jobs: ${delivery.queue}` },
            {
              label: 'To',
              value: route ? routeName(route) : 'A connection that was removed',
            },
            ...(delivery.routedJobId ? [{ label: 'Job made', value: delivery.routedJobId }] : []),
            { label: 'Happened', value: formatDateTime(delivery.occurredAt) },
            { label: 'Delivery', value: delivery.id },
          ]}
        />
        <h4 className="mb-2 mt-4 text-[13px] font-bold text-fg">Attempts ({delivery.attempts})</h4>
        {delivery.history.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">No attempt has finished yet.</p>
        ) : (
          <AttemptLine delivery={delivery} held={held} />
        )}
      </Card>
    </section>
  );
}
