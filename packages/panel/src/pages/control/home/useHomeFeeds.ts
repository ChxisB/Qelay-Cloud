import { api } from '@/lib/api';
import { bq } from '@/lib/bq';
import type { WebhookStatsFull } from '@/lib/bq';
import type { WebhookFull } from '@/lib/bqTypes';
import { useCapabilities } from '@/lib/capabilities/useCapabilities';
import { useAlertRuntimeStore } from '@/lib/useAlertEngine';
import { usePolledData } from '@/lib/usePolledData';

const DAY_MS = 86_400_000;
const GATEWAY_POLL_MS = 60_000;

export interface GatewayFeed {
  routes: WebhookFull[];
  /** The last day's totals; null when only the stats call failed. */
  stats: WebhookStatsFull | null;
}

/**
 * The reads Home adds to what Overview already loads: one call per area, each polled on its own, so
 * a failure leaves only that area's card in an error state. Alerts need no call: the engine in the
 * shell already evaluates them. The gateway is read only when this deployment serves it.
 */
export function useHomeFeeds(paused = false) {
  const { isPageAvailable } = useCapabilities();
  const gatewayOpen = isPageAvailable('/events-gateway');
  const deployment = usePolledData(() => api.deployment(), [], { paused });
  const transport = usePolledData(() => api.transport(), [], { paused });
  const gateway = usePolledData<GatewayFeed | null>(
    async () => {
      if (!gatewayOpen) return null;
      const until = Date.now();
      const [routes, stats] = await Promise.all([
        bq.webhooks(),
        bq.webhookStats({ since: until - DAY_MS, until }).catch(() => null),
      ]);
      return { routes: routes.data?.webhooks ?? [], stats: stats?.data.stats ?? null };
    },
    [gatewayOpen],
    // The 24 h stats read scans a day of events, so it is not worth the global cadence (3 s by default).
    { paused, intervalMs: GATEWAY_POLL_MS }
  );
  const breaches = useAlertRuntimeStore((s) => s.breaching);
  return { deployment, transport, gateway, gatewayOpen, breaches, isPageAvailable };
}
