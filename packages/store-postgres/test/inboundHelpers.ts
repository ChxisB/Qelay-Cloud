import type { InboundRequest, SourceIssued, SourceSpec } from '../src';
import type { TestStore } from './storeHelpers';

/** A JSON POST as the ingest would hand it over. */
export const post = (body: unknown, extra: Partial<InboundRequest> = {}): InboundRequest => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  query: {},
  contentType: 'application/json',
  body: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
  ...extra,
});

export const addSource = (
  t: Pick<TestStore, 'store'>,
  spec: Partial<SourceSpec> = {}
): Promise<SourceIssued> => t.store.sources.create({ name: 'Billing', ...spec }, 'tester');

/** A route of the source that POSTs to a receiver; rules as given. */
export const addRoute = (
  t: Pick<TestStore, 'store'>,
  source: string,
  spec: Parameters<TestStore['store']['webhooks']['create']>[0] = {}
) => t.store.webhooks.create({ url: 'https://hooks.example.com/in', ...spec, source }, 'tester');

export interface RequestDelivery {
  readonly webhook_id: string;
  readonly request_id: string | null;
  readonly event_name: string;
  readonly status: string;
  readonly body: string | null;
  readonly last_error: string | null;
  readonly next_attempt_at: string | number;
}

export const requestDeliveries = (t: TestStore): Promise<RequestDelivery[]> =>
  t.fresh.sql<RequestDelivery[]>`
    SELECT webhook_id, request_id::text AS request_id, event_name, status, body, last_error,
           next_attempt_at
    FROM qcloud_deliveries WHERE request_id IS NOT NULL ORDER BY webhook_id, id`;
