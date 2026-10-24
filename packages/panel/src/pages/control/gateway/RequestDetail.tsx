import { confirmInPage } from '@/components/dashboard/stores/confirmStore';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Facts } from '@/components/ui/Facts';
import { ErrorState, LoadingState } from '@/components/ui/feedback';
import { StatusPill, stateRole } from '@/components/ui/StatusBadge';
import { bq } from '@/lib/bq';
import type { WebhookFull } from '@/lib/bqTypes';
import { useCanOperate } from '@/lib/capabilities/useCapabilities';
import { formatDateTime } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import { useServerActionGuard } from '@/lib/useServerActionGuard';
import { EVENT_WORDS, routeName } from './model';
import { bytesLine, REQUEST_ROLE, REQUEST_WORDS } from './sourceModel';

const Pairs = ({ title, pairs }: { title: string; pairs: Record<string, string> }) => {
  const entries = Object.entries(pairs);
  return (
    <>
      <h4 className="mb-2 mt-4 text-[13px] font-bold text-fg">
        {title} ({entries.length})
      </h4>
      {entries.length === 0 ? (
        <p className="m-0 text-[13px] text-muted">None.</p>
      ) : (
        <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-[minmax(0,12rem)_1fr]">
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="break-all text-muted">{key}</dt>
              <dd className="m-0 break-all text-fg">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
};

/**
 * One request in full: what was posted (headers and query as stored, with the secrets blanked by the server), the
 * body, and the events each connection made from it. Everything a stranger sent is drawn as text. An operator can
 * replay an accepted request; a viewer gets no body.
 */
export function RequestDetail({
  id,
  routes,
  sources,
  onClose,
}: {
  id: string;
  routes: ReadonlyMap<string, WebhookFull>;
  sources: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  const canOperate = useCanOperate();
  const guard = useServerActionGuard('webhook-request-replay');
  const { data, error, loading, refetch } = usePolledData(() => bq.request(id), [id], {
    paused: true,
  });
  const request = data?.id === id ? data : null;

  const replay = async () => {
    const yes = await confirmInPage({
      question: `Replay request ${id}? Every connection that listens to its source now gets it again, as new events.`,
      confirmLabel: 'Replay request',
    });
    if (!yes) return;
    const lease = guard.begin(['webhook-replay', id]);
    if (!lease) return;
    try {
      const made = await bq.replayRequest(id);
      if (!lease.isCurrent()) return;
      toast.success(
        'Replay queued',
        made.deliveries === 0
          ? 'No connection listens to this source, so nothing was sent.'
          : `${made.deliveries} event${made.deliveries === 1 ? ' is' : 's are'} back in line, from ${made.routes} connection${made.routes === 1 ? '' : 's'}.`
      );
      await refetch();
    } catch (caught) {
      if (lease.isCurrent()) toast.error('Replay failed', (caught as Error).message);
    } finally {
      lease.finish();
    }
  };

  return (
    <section aria-label="Request details">
      <Card className="min-w-0">
        <CardHeader
          title="Request"
          headingLevel={3}
          action={
            <Button size="sm" onClick={onClose}>
              Close
            </Button>
          }
        />
        {error && !request ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : loading || !request ? (
          <LoadingState label="Loading request…" />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <StatusPill state={REQUEST_ROLE[request.status]}>
                {REQUEST_WORDS[request.status]}
              </StatusPill>
              {canOperate && request.status === 'accepted' && (
                <Button size="sm" onClick={() => void replay()}>
                  Replay
                </Button>
              )}
            </div>
            {request.cause && (
              <div className="mb-3">
                <Banner tone="warn" title="Not accepted">
                  {request.cause}
                </Banner>
              </div>
            )}
            <Facts
              items={[
                { label: 'Request', value: `${request.method} ${request.id}` },
                { label: 'Source', value: sources.get(request.sourceId) ?? request.sourceId },
                { label: 'Received', value: formatDateTime(request.receivedAt) },
                {
                  label: 'Content',
                  value: `${request.contentType ?? 'no content type'}, ${bytesLine(request.bodyBytes)}`,
                },
              ]}
            />
            <Pairs title="Headers" pairs={request.headers} />
            <Pairs title="Query" pairs={request.query} />
            <h4 className="mb-2 mt-4 text-[13px] font-bold text-fg">Body</h4>
            {request.body ? (
              <>
                {request.body.encoding === 'base64' && (
                  <p className="m-0 mb-1 text-xs text-muted">Not text, so shown as base64.</p>
                )}
                <CodeBlock label="Request body" className="whitespace-pre-wrap break-all">
                  {request.body.data}
                </CodeBlock>
              </>
            ) : (
              <p className="m-0 text-[13px] text-muted">
                {request.bodyRedacted
                  ? 'The body is hidden from read-only access.'
                  : 'No body was stored.'}
              </p>
            )}
            <h4 className="mb-2 mt-4 text-[13px] font-bold text-fg">
              Events made ({request.deliveries.length})
            </h4>
            {request.deliveries.length === 0 ? (
              <p className="m-0 text-[13px] text-muted">
                No connection made an event from it
                {request.status === 'rejected'
                  ? ': a rejected request is kept but not sent on.'
                  : '.'}
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {request.deliveries.map((delivery) => {
                  const owner = routes.get(delivery.webhookId);
                  return (
                    <li key={delivery.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                      <StatusPill state={stateRole(delivery.status)}>
                        {EVENT_WORDS[delivery.status]}
                      </StatusPill>
                      <span className="text-fg">
                        {owner ? routeName(owner) : 'A connection that was removed'}
                      </span>
                      <span className="text-muted">
                        by {delivery.via === 'queue' ? 'queue' : 'web address'}, {delivery.attempts}{' '}
                        attempt{delivery.attempts === 1 ? '' : 's'}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </Card>
    </section>
  );
}
