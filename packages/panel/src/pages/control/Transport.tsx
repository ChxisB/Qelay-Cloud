import { Card } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { LinkButton } from '@/components/ui/LinkButton';
import { PageHeader } from '@/components/ui/PageHeader';
import { api } from '@/lib/api';
import { useCanOperate } from '@/lib/capabilities/useCapabilities';
import { formatRelativeTime } from '@/lib/format';
import { figure, span } from '@/lib/ops/health';
import { usePolledData } from '@/lib/usePolledData';
import { DeadLetterPanel } from './transport/DeadLetterPanel';
import { QueueDoorbellTable } from './transport/QueueDoorbellTable';

/** The tick is "behind" for a claimable job once it has waited this long without a doorbell. */
const TICK_BEHIND_AFTER_MS = 60_000;

const ORDERING: Record<string, string> = {
  none: 'No ordering: bells may arrive in any order.',
  'best-effort': 'Best-effort ordering.',
};

function delayWords(maxDeliverDelayMs: number | null): string {
  if (maxDeliverDelayMs === null) return 'No limit: the broker holds a bell until it is due.';
  if (maxDeliverDelayMs === 0)
    return 'None: the broker cannot delay a bell, so the tick rings a job when it is due.';
  return `Up to ${span(maxDeliverDelayMs)}. A job due later is rung by the tick once it is within that.`;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="eyebrow text-muted">{label}</dt>
      <dd className="text-sm text-fg">{children}</dd>
    </div>
  );
}

/**
 * The doorbell path: what the broker reports next to what the database holds, queue by queue. The
 * database is the truth about jobs; the broker is only the bell, so the page reads the two against
 * each other and says what a gap between them means.
 */
export function Transport() {
  const canOperate = useCanOperate();
  const { data, error, loading, refetch } = usePolledData(() => api.transport(), []);

  if (loading && !data && !error) return <LoadingState label="Loading transport…" />;
  if (error && !data) {
    return (
      <div>
        <PageHeader title="Transport" description="The doorbell path is unavailable." />
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
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Transport"
        description={`How doorbells move between the database and the workers. Read ${formatRelativeTime(data.timestamp)}.`}
        actions={
          <LinkButton to="/deployment" variant="ghost">
            Deployment
          </LinkButton>
        }
      />
      {error && (
        <OfflineBanner
          message="Connection lost — showing the last successful reading."
          onRetry={refetch}
        />
      )}
      <Card>
        <dl className="grid gap-5 sm:grid-cols-3">
          <Fact label="Transport">
            <span className="font-semibold">{data.transport.name}</span>
          </Fact>
          <Fact label="Ordering">
            {ORDERING[data.transport.ordering] ?? data.transport.ordering}
          </Fact>
          <Fact label="Longest delay a bell can carry">
            {delayWords(data.transport.maxDeliverDelayMs)}
          </Fact>
        </dl>
      </Card>
      <Card>
        <h2 className="text-base font-semibold text-fg">How to read this</h2>
        <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted">
          <li>
            <strong className="text-fg">Claimable</strong> and{' '}
            <strong className="text-fg">No doorbell</strong> come from the database. A large and
            growing "No doorbell" means jobs are ready and nobody rang for them: the tick is behind.
          </li>
          <li>
            <strong className="text-fg">At broker</strong>,{' '}
            <strong className="text-fg">Oldest bell</strong> and{' '}
            <strong className="text-fg">Dead-letter</strong> come from the broker's metrics. Cloud
            metrics lag by minutes, so each row says how old its figures are. "unknown" means the
            figure could not be read; it is not zero.
          </li>
          {data.transport.approximateCounts && (
            <li>
              This broker's counts are <strong className="text-fg">approximate</strong> (marked
              "≈"): they are eventually consistent and can trail the queue by about a minute.{' '}
              <strong className="text-fg">In flight</strong> bells were taken by a worker and not
              yet acknowledged; <strong className="text-fg">Delayed</strong> bells are held back
              until they are due. Read a trend, not a single figure.
            </li>
          )}
          <li>
            A deep <strong className="text-fg">Dead-letter</strong> queue means poison doorbells:
            bells the broker gave up delivering. The jobs themselves are safe in the database.
          </li>
          <li>
            More jobs than workers is normal: bells wait at the broker and the tick rings old jobs
            again.
          </li>
        </ul>
      </Card>
      <section
        aria-label="Doorbell health"
        className="overflow-hidden rounded-card border border-line bg-surface"
      >
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
          <p className="border-t border-line px-4 py-3 text-xs text-muted">
            More queues exist than are shown: the {figure(data.queues.length)} with the most pending
            jobs come first.
          </p>
        )}
      </section>
      <DeadLetterPanel
        queues={deadLetterQueues.length > 0 ? deadLetterQueues : allQueues}
        supported={data.deadLetter.supported}
        canOperate={canOperate}
      />
    </div>
  );
}
