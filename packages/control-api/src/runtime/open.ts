import type { DeliveryTransport } from '@qelay-cloud/core';
import { systemClock } from '@qelay-cloud/core';
import { openDatabase, PostgresStore } from '@qelay-cloud/store-postgres';
import { describeTransport, openTransport } from '@qelay-cloud/transports';
import type { ControlApiDeps } from '../deps';
import { postgresReadiness, TransportReachability } from '../readiness';
import { observeReachability } from './observe';
import type { RuntimeSettings } from './settings';

/** What the process serves from: the store, the broker and the dependencies built over them. */
export interface Runtime {
  readonly deps: ControlApiDeps;
  close(): Promise<void>;
}

export type OpenRuntime = (settings: RuntimeSettings) => Runtime;

/** The widest window a store takes, as the tick and the SDK use it: a year and a day. */
const MAX_RING_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

/** How far ahead the transport can hold a bell, as a finite number (the tick's `transportWindowMs`). */
function windowMs(transport: DeliveryTransport): number {
  const max = transport.capabilities.maxDeliverDelayMs;
  return Number.isFinite(max) ? Math.max(0, Math.floor(max)) : MAX_RING_WINDOW_MS;
}

/**
 * Opens the database and the broker from the settings. Nothing connects until the first request
 * (the pool is lazy), so a wrong URL shows in `/health/ready`, not as a crash loop.
 */
export function openRuntime(settings: RuntimeSettings): Runtime {
  const db = openDatabase(settings.database);
  // The store's window is the transport's, and a transport needs the store's doorbell for its
  // polling, so the store is built twice over one database: first to read from, then to serve with.
  const reader = new PostgresStore({ db, namespace: settings.namespace });
  const inner = openTransport(settings, {
    namespace: settings.namespace,
    local: { db, source: reader.doorbell },
  });
  const described = describeTransport(settings.transport);
  const store = new PostgresStore({
    db,
    namespace: settings.namespace,
    ringWindowMs: windowMs(inner),
    ...(settings.webhooks.key === undefined ? {} : { webhookKey: settings.webhooks.key }),
  });
  const reachability = new TransportReachability(systemClock);
  const transport = observeReachability(inner, reachability);
  return {
    deps: {
      transport: {
        name: described.name,
        capabilities: inner.capabilities,
        doorbellDeadLetter: described.doorbellDeadLetter,
        approximateCounts: described.approximateCounts,
      },
      ...(Object.keys(settings.features).length === 0 ? {} : { features: settings.features }),
      readiness: postgresReadiness(db, store, reachability),
      jobs: {
        store,
        transport,
        options: settings.jobs,
        webhookUrlPolicy: settings.webhooks.urlPolicy,
      },
    },
    close: async () => {
      await inner.close().catch(() => {});
      await store.close({ timeout: 5_000 }).catch(() => {});
    },
  };
}
