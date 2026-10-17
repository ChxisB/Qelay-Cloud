import { useEffect, useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/feedback';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { bq, type WebhookDeliveryFull, type WebhookDeliveryStatus } from '@/lib/bq';
import { formatRelativeTime } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import { assertSuccessfulMutationResponse, useServerActionGuard } from '@/lib/useServerActionGuard';

const PAGE_LIMIT = 10;
const FILTERS: readonly { value: WebhookDeliveryStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'failed', label: 'Failed' },
  { value: 'pending', label: 'Pending' },
  { value: 'delivered', label: 'Delivered' },
];

/** `#1 500 · #2 503 · #3 200`: what each attempt got back, oldest first. */
export function attemptSummary(delivery: WebhookDeliveryFull): string {
  return delivery.history
    .map((entry) => `#${entry.attempt} ${entry.statusCode ?? 'no answer'}`)
    .join(' · ');
}

/**
 * The deliveries of one webhook: status, attempts and the last error, newest first. Errors are the
 * sender's fixed sentences; the history never holds the address, the secret or a response body, so
 * there is nothing here that needs hiding. A failed delivery can be retried, and a test event sent.
 */
export function DeliveryHistory({ id, enabled }: { id: string; enabled: boolean }) {
  const [status, setStatus] = useState<WebhookDeliveryStatus | 'all'>('all');
  // `before` cursors of the pages already walked past: the last one is the page on screen.
  const [trail, setTrail] = useState<string[]>([]);
  const before = trail.at(-1);
  const guard = useServerActionGuard(`webhook-deliveries:${id}`);
  const { data, error, loading, refetch } = usePolledData(
    () =>
      bq.webhookDeliveries(id, {
        limit: PAGE_LIMIT,
        ...(before === undefined ? {} : { before }),
        ...(status === 'all' ? {} : { status }),
      }),
    [id, before, status]
  );
  const [busy, setBusy] = useState<string | null>(null);

  // A new connection is a new registry: nothing in flight or walked belongs to it.
  useEffect(() => {
    setBusy(null);
    setTrail([]);
  }, [guard.scopeKey]);

  const run = async (key: string, action: () => Promise<unknown>, label: string) => {
    const lease = guard.begin(['webhook-delivery', `${id}:${key}`]);
    if (!lease) return;
    setBusy(key);
    try {
      assertSuccessfulMutationResponse(await action(), label);
      if (lease.isCurrent()) void refetch();
    } catch (caught) {
      if (lease.isCurrent()) toast.error(`${label} failed`, (caught as Error).message);
    } finally {
      if (lease.finish()) setBusy(null);
    }
  };

  const deliveries = data?.data.deliveries ?? [];
  const next = data?.data.next ?? null;

  return (
    <div className="flex flex-col gap-3" aria-label="Delivery history">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            aria-pressed={status === filter.value}
            onClick={() => {
              setStatus(filter.value);
              setTrail([]);
            }}
            className={
              status === filter.value
                ? 'rounded-full bg-selected px-3 py-1 text-xs font-medium text-link'
                : 'rounded-full border border-line px-3 py-1 text-xs font-medium text-muted hover:text-fg'
            }
          >
            {filter.label}
          </button>
        ))}
        <span className="grow" />
        <Button
          size="sm"
          disabled={!enabled || busy !== null}
          title={enabled ? undefined : 'Enable the webhook to send a test event'}
          onClick={() => run('test', () => bq.testWebhook(id), 'Send test event')}
        >
          Send test event
        </Button>
      </div>

      {error && !data ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <LoadingState label="Loading deliveries…" />
      ) : deliveries.length === 0 ? (
        <EmptyState title="No deliveries" hint="Deliveries appear here once an event matches." />
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left eyebrow text-muted">
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Event</th>
                <th className="px-3 py-2 font-semibold">Job</th>
                <th className="px-3 py-2 font-semibold">Attempts</th>
                <th className="px-3 py-2 font-semibold">Last error</th>
                <th className="px-3 py-2 text-right font-semibold">When</th>
                <th className="w-20 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.id} className="border-b border-line align-top last:border-0">
                  <td className="px-3 py-2">
                    <StatusBadge status={delivery.status} />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-fg">{delivery.event}</td>
                  <td className="max-w-[12rem] truncate px-3 py-2 font-mono text-xs text-muted">
                    {delivery.queue} / {delivery.jobId}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted" title={attemptSummary(delivery)}>
                    {delivery.attempts}
                    {delivery.history.length > 0 && (
                      <span className="block text-faint">{attemptSummary(delivery)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-danger">
                    {delivery.status === 'delivered' ? '' : (delivery.lastError ?? '')}
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-faint">
                    {formatRelativeTime(delivery.finishedAt ?? delivery.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {delivery.status === 'failed' && (
                      <Button
                        size="sm"
                        aria-label={`Retry delivery ${delivery.id}`}
                        disabled={busy !== null}
                        onClick={() =>
                          run(
                            delivery.id,
                            () => bq.retryWebhookDelivery(id, delivery.id),
                            'Retry delivery'
                          )
                        }
                      >
                        Retry
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(trail.length > 0 || next !== null) && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={trail.length === 0}
            onClick={() => setTrail((current) => current.slice(0, -1))}
          >
            Newer
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={next === null}
            onClick={() => next !== null && setTrail((current) => [...current, next])}
          >
            Older
          </Button>
        </div>
      )}
    </div>
  );
}
