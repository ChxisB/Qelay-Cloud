import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { LinkButton } from '@/components/ui/LinkButton';
import { StatusBadge } from '@/components/ui/StatusBadge';
import type { ActivityEvent } from '@/lib/types';

/** The full record of the line picked in the viewer: what the line cannot fit, and the way to the job. */
export function SelectedEvent({ event, onClose }: { event: ActivityEvent; onClose: () => void }) {
  const at = new Date(event.timestamp).toISOString();
  return (
    <section aria-label="Selected event" className="mt-6">
      <Card>
        <CardHeader
          title="Selected event"
          sub={`${at}${event.queue ? ` on ${event.queue}` : ''}`}
          action={
            <div className="flex flex-wrap items-center gap-2">
              {event.jobId && (
                <LinkButton to={`/job?id=${encodeURIComponent(event.jobId)}`} size="sm">
                  Open job
                </LinkButton>
              )}
              <Button size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          }
        />
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-8 gap-y-3 text-[13px]">
          <dt className="text-[13px] font-bold text-muted">Job</dt>
          <dd className="flex min-w-0 items-center gap-2 font-mono text-sm">
            <span className="truncate">{event.jobId ?? '—'}</span>
            {event.jobId && <CopyButton value={event.jobId} />}
          </dd>
          <dt className="text-[13px] font-bold text-muted">Queue</dt>
          <dd className="font-mono text-sm">{event.queue || '—'}</dd>
          <dt className="text-[13px] font-bold text-muted">Status</dt>
          <dd>
            <StatusBadge status={event.status} />
          </dd>
          <dt className="text-[13px] font-bold text-muted">Event</dt>
          <dd className="font-mono text-sm">{event.event}</dd>
          {event.error && (
            <>
              <dt className="text-[13px] font-bold text-muted">Error</dt>
              <dd className="font-mono text-sm break-words text-danger">{event.error}</dd>
            </>
          )}
        </dl>
      </Card>
    </section>
  );
}
