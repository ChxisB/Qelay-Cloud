import { HealthTabs } from '@/components/HealthTabs';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { Tag, type TagTone } from '@/components/ui/Tag';
import { api } from '@/lib/api';
import { useCanOperate } from '@/lib/capabilities/useCapabilities';
import { formatRelativeTime } from '@/lib/format';
import { figure, span } from '@/lib/ops/health';
import { usePolledData } from '@/lib/usePolledData';
import { DeadLetterPanel } from './transport/DeadLetterPanel';
import { DeliveryLine } from './transport/DeliveryLine';
import { QueueDoorbellTable } from './transport/QueueDoorbellTable';

/** Maintenance is "behind" for a ready job once it has waited this long without a notification. */
const TICK_BEHIND_AFTER_MS = 60_000;

const ORDERING: Record<string, string> = {
  none: 'No ordering: notifications may arrive in any order.',
  'best-effort': 'Best-effort ordering.',
};

function delayWords(maxDeliverDelayMs: number | null): string {
  if (maxDeliverDelayMs === null) {
    return 'No limit: the queue service holds a notification until the job is due.';
  }
  if (maxDeliverDelayMs === 0) {
    return 'None: the queue service cannot hold a notification back, so maintenance sends it when the job is due.';
  }
  return `Up to ${span(maxDeliverDelayMs)}. For a job due later, maintenance sends the notification once it is within that.`;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <dt className="eyebrow text-muted">{label}</dt>
      <dd className="text-[13px] text-fg">{children}</dd>
    </div>
  );
}

// shortcut: the tag colour follows the name's prefix and the label is the API's own name; a
// transport with any other name is neutral. Upgrade if the API ever reports a provider field.
const transportTone = (name: string): TagTone =>
  name.startsWith('gcp') ? 'gcp' : name.startsWith('aws') ? 'aws' : 'neutral';

/**
 * Job delivery (the doorbell path): what the queue service (the broker) reports next to what the
 * database holds, queue by queue. The database is the truth about jobs; the queue service only
 * tells workers to look, so the page reads the two against each other and says what a gap between
 * them means.
 */
export function Transport() {
  const canOperate = useCanOperate();
  const { data, error, loading, refetch } = usePolledData(() => api.transport(), []);

  if (loading && !data && !error) return <LoadingState label="Loading job delivery…" />;
  if (error && !data) {
    return (
      <div>
        <PageHeader title="Job delivery" description="Job delivery is unavailable." />
        <HealthTabs current="/transport" />
        <ErrorState error={error} onRetry={refetch} />
      </div>
    );
  }
  if (!data) return null;

  const deadLetterQueues = data.queues
    .filter((queue) => (queue.deadLetterDepth ?? 0) > 0)
    .map((queue) => queue.queue);
  const allQueues = data.queues.map((queue) => queue.queue);

  return (
    <div>
      <PageHeader
        title="Job delivery"
        description={`How workers are told that a job is ready, from the database through the queue service. Read ${formatRelativeTime(data.timestamp)}.`}
      />
      <HealthTabs current="/transport" />
      <div className="flex flex-col gap-6">
        {error && (
          <OfflineBanner
            message="Connection lost — showing the last successful reading."
            onRetry={refetch}
          />
        )}
        <Card>
          <dl className="grid gap-5 sm:grid-cols-3">
            <Fact label="Queue service">
              <Tag tone={transportTone(data.transport.name)}>{data.transport.name}</Tag>
            </Fact>
            <Fact label="Ordering">
              {ORDERING[data.transport.ordering] ?? data.transport.ordering}
            </Fact>
            <Fact label="Longest it can hold a job back">
              {delayWords(data.transport.maxDeliverDelayMs)}
            </Fact>
          </dl>
        </Card>
        <Card>
          <CardHeader title="How to read this" sub="What each figure in the table below means." />
          <ul className="flex list-disc flex-col gap-2 pl-5 text-[13px] text-muted">
            <li>
              <strong className="text-fg">Ready to run</strong> and{' '}
              <strong className="text-fg">Not notified</strong> come from the database. A large and
              growing "Not notified" means jobs are ready but no worker was told: maintenance is
              behind.
            </li>
            <li>
              <strong className="text-fg">In queue service</strong>,{' '}
              <strong className="text-fg">Oldest waiting</strong> and{' '}
              <strong className="text-fg">Failed notifications</strong> come from the queue
              service's metrics. Cloud metrics lag by minutes, so each row says how old its figures
              are. "unknown" means the figure could not be read; it is not zero.
            </li>
            {data.transport.approximateCounts && (
              <li>
                This queue service's counts are <strong className="text-fg">approximate</strong>{' '}
                (marked "≈"): they can trail the real queue by about a minute.{' '}
                <strong className="text-fg">Picked up</strong> notifications were taken by a worker
                and not yet confirmed; <strong className="text-fg">Delayed</strong> notifications
                are held back until the job is due. Read a trend, not a single figure.
              </li>
            )}
            <li>
              Many <strong className="text-fg">Failed notifications</strong> mean the queue service
              gave up telling workers about those jobs. The jobs themselves are safe in the
              database.
            </li>
            <li>
              More jobs than workers is normal: notifications wait in the queue service and
              maintenance sends them again for old jobs.
            </li>
          </ul>
        </Card>
        {data.queues.length > 0 && (
          <DeliveryLine
            queues={data.queues}
            lateAfterMs={TICK_BEHIND_AFTER_MS}
            approximate={data.transport.approximateCounts}
            truncated={data.truncated}
          />
        )}
        <section aria-label="Notification health">
          <Card padded={false}>
            <div className="px-4 pt-6">
              <CardHeader
                title="Notification health"
                sub="The database's figures are exact. The queue service's lag, so each row says how old they are."
              />
            </div>
            {data.queues.length === 0 ? (
              <EmptyState title="No queues yet" hint="Queues appear here once a job is added." />
            ) : (
              <QueueDoorbellTable
                queues={data.queues}
                lateAfterMs={TICK_BEHIND_AFTER_MS}
                approximate={data.transport.approximateCounts}
              />
            )}
            {data.truncated && (
              <p className="border-t border-line px-4 py-4 text-[13px] text-muted">
                More queues exist than are shown: the {figure(data.queues.length)} with the most
                pending jobs come first.
              </p>
            )}
          </Card>
        </section>
        <DeadLetterPanel
          queues={deadLetterQueues.length > 0 ? deadLetterQueues : allQueues}
          supported={data.deadLetter.supported}
          canOperate={canOperate}
        />
      </div>
    </div>
  );
}
