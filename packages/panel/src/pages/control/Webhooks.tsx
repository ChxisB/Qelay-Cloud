import { useEffect, useRef, useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconLightning } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { bq } from '@/lib/bq';
import { usePolledData } from '@/lib/usePolledData';
import {
  assertSuccessfulMutationResponse,
  type ServerActionLease,
  useServerActionGuard,
} from '@/lib/useServerActionGuard';
import { WebhookForm } from './webhooks/WebhookForm';
import { WebhookRow } from './webhooks/WebhookRow';

export { buildWebhookBody, displayWebhookUrl, isDeliverableUrl } from './webhooks/model';

/**
 * Page state clamped to the live page count. Clamps the STATE, not just the
 * rendered value: with only the render clamped, a list that shrinks (delete)
 * and then regrows (add) jumps the table to a page nobody navigated to.
 */
export function useClampedPage(pageCount: number): [number, (p: number) => void] {
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);
  return [Math.min(page, pageCount - 1), setPage];
}

export function Webhooks() {
  const { data, error, loading, refetch } = usePolledData(() => bq.webhooks(), []);
  const webhooks = data?.data?.webhooks ?? [];
  const PAGE_SIZE = 15;
  const pageCount = Math.max(1, Math.ceil(webhooks.length / PAGE_SIZE));
  const [safePage, setPage] = useClampedPage(pageCount);

  const [actErr, setActErr] = useState<string | null>(null);
  // The webhook whose delivery history is open: one at a time.
  const [openId, setOpenId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const actionGuard = useServerActionGuard('webhooks');

  // Optimistic enable/disable: flip the switch immediately, then let the server
  // confirm. Each value carries its intent token: an older request's finally
  // may only remove its own override, never a newer click's value.
  const [optimistic, setOptimistic] = useState<Record<string, { value: boolean; intent: symbol }>>(
    {}
  );
  const toggleRuns = useRef(
    new Map<string, { desired: boolean; intent: symbol; lease: ServerActionLease }>()
  );

  // scopeKey is the connection lifecycle boundary.
  useEffect(() => {
    setActErr(null);
    setRemoving(new Set());
    setOpenId(null);
    setOptimistic({});
    toggleRuns.current.clear();
  }, [actionGuard.scopeKey]);

  const remove = async (id: string) => {
    const lease = actionGuard.begin(['registry-write', `webhook:${id}`]);
    if (!lease) return;
    setActErr(null);
    setRemoving((current) => new Set(current).add(id));
    try {
      const response = await bq.removeWebhook(id);
      assertSuccessfulMutationResponse(response, 'Remove webhook');
      if (!lease.isCurrent()) return;
      void refetch();
    } catch (e) {
      if (!lease.isCurrent()) return;
      // Surface the failure — a confirmed delete that silently no-ops reads as
      // success even though the row remains.
      setActErr((e as Error).message);
    } finally {
      if (lease.finish()) {
        setRemoving((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    }
  };

  const toggleEnabled = (id: string, next: boolean) => {
    // Keep one network writer per webhook. New clicks update the desired value
    // and are coalesced; a newer request is launched only after the previous
    // response, so an older server mutation can never finish last.
    const intent = Symbol('webhook-toggle');
    const active = toggleRuns.current.get(id);
    if (active) {
      active.desired = next;
      active.intent = intent;
      setOptimistic((current) => ({ ...current, [id]: { value: next, intent } }));
      return;
    }
    const lease = actionGuard.begin(`webhook:${id}`);
    if (!lease) return;
    const run = { desired: next, intent, lease };
    toggleRuns.current.set(id, run);
    setOptimistic((current) => ({ ...current, [id]: { value: next, intent } }));

    void (async () => {
      // Release the lock on every exit (navigation, scope change, coalesced
      // loop end) — a leaked module-global lock keeps this row disabled.
      try {
        while (lease.isCurrent() && toggleRuns.current.get(id) === run) {
          const sentValue = run.desired;
          let error: Error | null = null;
          try {
            const response = await bq.setWebhookEnabled(id, sentValue);
            assertSuccessfulMutationResponse(response, 'Toggle webhook');
          } catch (caught) {
            error = caught instanceof Error ? caught : new Error(String(caught));
          }
          if (!lease.isCurrent() || toggleRuns.current.get(id) !== run) return;
          // If the desired state changed while this request was in flight, send
          // only the newest value. Intermediate clicks never reach the server.
          if (run.desired !== sentValue) continue;
          // Reconcile even after an error: the server may have committed the
          // write before the response was lost. The optimistic value stays in
          // place while this read completes, so it cannot visibly snap back.
          await refetch();
          if (!lease.isCurrent() || toggleRuns.current.get(id) !== run) return;
          // A click can arrive while the final refetch is in flight.
          if (run.desired !== sentValue) continue;
          toggleRuns.current.delete(id);
          const finalIntent = run.intent;
          setOptimistic((current) => {
            if (current[id]?.intent !== finalIntent) return current;
            const { [id]: _dropped, ...rest } = current;
            return rest;
          });
          if (error) toast.error('Webhook toggle failed', error.message);
          return;
        }
      } finally {
        lease.finish();
      }
    })();
  };

  return (
    <div>
      <PageHeader
        title="Webhooks"
        description="HTTP callbacks fired on job events, with the delivery history of each."
        live={!!data && !error}
      />

      {error && data && (
        <OfflineBanner
          message="Webhook refresh failed — showing the last successful registry."
          onRetry={refetch}
        />
      )}
      {actErr && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-danger/20 bg-danger/5 px-4 py-2 text-sm text-danger"
        >
          {actErr}
        </div>
      )}

      <Card className="mb-6">
        <CardHeader title="Add webhook" />
        <WebhookForm
          onAdd={(body) => bq.addWebhook(body)}
          onAccepted={() => void refetch()}
          beginAdd={() => actionGuard.begin(['registry-write', 'add'])}
          scopeKey={actionGuard.scopeKey}
        />
      </Card>

      {error && !data ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <LoadingState label="Loading webhooks…" />
      ) : webhooks.length === 0 ? (
        <EmptyState
          icon={<IconLightning />}
          title="No webhooks"
          hint="Add one above to receive job-event callbacks."
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-card border border-line bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left eyebrow text-muted light:bg-surface-2">
                  <th className="px-4 py-2.5 font-semibold">URL</th>
                  <th className="px-4 py-2.5 font-semibold">Events</th>
                  <th className="px-4 py-2.5 font-semibold">Queue</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Success / Fail</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Last</th>
                  <th className="px-4 py-2.5 font-semibold">Enabled</th>
                  <th className="w-24 px-4 py-2.5" />
                  <th className="w-12 px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {webhooks.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE).map((w) => (
                  <WebhookRow
                    key={w.id}
                    webhook={w}
                    enabled={optimistic[w.id]?.value ?? w.enabled}
                    removing={removing.has(w.id)}
                    open={openId === w.id}
                    onToggleOpen={() => setOpenId((current) => (current === w.id ? null : w.id))}
                    onToggleEnabled={(next) => toggleEnabled(w.id, next)}
                    onRemove={() => remove(w.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={safePage}
            pageSize={PAGE_SIZE}
            total={webhooks.length}
            onPageChange={setPage}
            label="webhooks"
          />
        </>
      )}
    </div>
  );
}
