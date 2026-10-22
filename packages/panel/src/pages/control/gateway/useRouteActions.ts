import { useEffect, useRef, useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import { bq, type WebhookPauseMode } from '@/lib/bq';
import {
  assertSuccessfulMutationResponse,
  type ServerActionLease,
  useServerActionGuard,
} from '@/lib/useServerActionGuard';

/** The switch as shown while a change is in flight: on or off, and how an off one is paused. */
export interface Switched {
  value: boolean;
  mode?: WebhookPauseMode;
  intent: symbol;
}

/**
 * Remove, test and the on/off switch of the connections list and of a connection's page. The switch is optimistic: it flips at once,
 * then the server confirms. Each value carries its intent token, so an older request's finally may
 * only remove its own override, never a newer click's value.
 */
export function useRouteActions(refetch: () => Promise<void>) {
  const [actErr, setActErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [testing, setTesting] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<Record<string, Switched>>({});
  const toggleRuns = useRef(
    new Map<
      string,
      { desired: boolean; mode?: WebhookPauseMode; intent: symbol; lease: ServerActionLease }
    >()
  );
  const actionGuard = useServerActionGuard('webhooks');

  // scopeKey is the connection lifecycle boundary.
  useEffect(() => {
    setActErr(null);
    setRemoving(new Set());
    setTesting(null);
    setOptimistic({});
    toggleRuns.current.clear();
  }, [actionGuard.scopeKey]);

  /** True once the server has removed the connection. */
  const remove = async (id: string): Promise<boolean> => {
    const lease = actionGuard.begin(['registry-write', `webhook:${id}`]);
    if (!lease) return false;
    setActErr(null);
    setRemoving((current) => new Set(current).add(id));
    try {
      const response = await bq.removeWebhook(id);
      assertSuccessfulMutationResponse(response, 'Remove connection');
      if (!lease.isCurrent()) return false;
      void refetch();
      return true;
    } catch (e) {
      // A confirmed delete that silently no-ops would read as success while the row remains.
      if (lease.isCurrent()) setActErr((e as Error).message);
      return false;
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

  /** Queue one test event for a connection; the Events screen shows it. */
  const test = async (id: string) => {
    const lease = actionGuard.begin(['webhook-delivery', `${id}:test`]);
    if (!lease) return;
    setTesting(id);
    try {
      assertSuccessfulMutationResponse(await bq.testWebhook(id), 'Send test event');
      if (lease.isCurrent()) toast.success('Test event queued', 'It shows on the Events screen.');
    } catch (caught) {
      if (lease.isCurrent()) toast.error('Send test event failed', (caught as Error).message);
    } finally {
      if (lease.finish()) setTesting(null);
    }
  };

  /** `mode` is how an off connection is paused: `hold` collects events, `ignore` (the default) does not. */
  const toggleEnabled = (id: string, next: boolean, mode?: WebhookPauseMode) => {
    // One network writer per connection. New clicks update the desired value and are coalesced; a newer
    // request is launched only after the previous response, so an older mutation can never finish last.
    const intent = Symbol('webhook-toggle');
    const active = toggleRuns.current.get(id);
    if (active) {
      active.desired = next;
      active.mode = mode;
      active.intent = intent;
      setOptimistic((current) => ({ ...current, [id]: { value: next, mode, intent } }));
      return;
    }
    const lease = actionGuard.begin(`webhook:${id}`);
    if (!lease) return;
    const run = { desired: next, mode, intent, lease };
    toggleRuns.current.set(id, run);
    setOptimistic((current) => ({ ...current, [id]: { value: next, mode, intent } }));

    void (async () => {
      // Release the lock on every exit: a leaked module-global lock keeps this row disabled.
      try {
        while (lease.isCurrent() && toggleRuns.current.get(id) === run) {
          const sentValue = run.desired;
          const sentMode = run.mode;
          let error: Error | null = null;
          try {
            assertSuccessfulMutationResponse(
              await bq.setWebhookEnabled(id, sentValue, sentMode),
              'Toggle connection'
            );
          } catch (caught) {
            error = caught instanceof Error ? caught : new Error(String(caught));
          }
          if (!lease.isCurrent() || toggleRuns.current.get(id) !== run) return;
          // Only the newest value reaches the server; intermediate clicks never do.
          if (run.desired !== sentValue || run.mode !== sentMode) continue;
          // Reconcile even after an error: the server may have committed before the response was lost.
          // The optimistic value stays while this read completes, so it cannot visibly snap back.
          await refetch();
          if (!lease.isCurrent() || toggleRuns.current.get(id) !== run) return;
          if (run.desired !== sentValue || run.mode !== sentMode) continue;
          toggleRuns.current.delete(id);
          const finalIntent = run.intent;
          setOptimistic((current) => {
            if (current[id]?.intent !== finalIntent) return current;
            const { [id]: _dropped, ...rest } = current;
            return rest;
          });
          if (error) toast.error('Connection toggle failed', error.message);
          return;
        }
      } finally {
        lease.finish();
      }
    })();
  };

  return { actionGuard, actErr, removing, testing, optimistic, remove, test, toggleEnabled };
}
