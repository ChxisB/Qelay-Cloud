import type { Json } from './shared';
import { demoRequestDeliveries } from './webhooks';

const NOW = Date.parse('2026-03-14T17:30:00Z');
const MINUTE = 60_000;

const SOURCES: readonly Json[] = [
  {
    id: 'src_demo',
    name: 'Shop checkout',
    enabled: true,
    verification: { kind: 'hmac', header: 'x-signature', username: null },
    signed: true,
    previousSecretUntil: null,
    rejectedDropped: 0,
    createdAt: NOW - 30 * 24 * 60 * MINUTE,
    updatedAt: NOW - 30 * 24 * 60 * MINUTE,
  },
  {
    id: 'src_partner',
    name: 'Partner feed',
    enabled: false,
    verification: { kind: 'api_key', header: 'x-api-key', username: null },
    signed: true,
    previousSecretUntil: null,
    rejectedDropped: 4,
    createdAt: NOW - 9 * 24 * 60 * MINUTE,
    updatedAt: NOW - 2 * 24 * 60 * MINUTE,
  },
];

const request = (id: string, ago: number, status: string, cause: string | null): Json => ({
  id,
  sourceId: 'src_demo',
  receivedAt: NOW - ago,
  method: 'POST',
  contentType: 'application/json',
  status,
  cause,
  bodyBytes: status === 'accepted' ? 25 : null,
});

/** Three requests of the demo's one source: two accepted (the demo's events come from them) and one refused. */
const REQUESTS: readonly Json[] = [
  request('4822', 5 * MINUTE, 'rejected', 'the signature did not match'),
  request('4821', 90 * MINUTE, 'accepted', null),
  request('4820', 120 * MINUTE, 'accepted', null),
];

/** `GET /sources`. */
export const demoSources = (): Json => ({ ok: true, data: { sources: SOURCES } });

/** `GET /requests`, filtered by `source` and `status`; the demo has one page. */
export function demoRequests(search: string): Json {
  const query = new URLSearchParams(search);
  const status = query.get('status');
  const source = query.get('source');
  const requests = REQUESTS.filter(
    (row) =>
      (status === null || row.status === status) && (source === null || row.sourceId === source)
  );
  return { ok: true, data: { requests, next: null } };
}

/** `GET /requests/:id`: the request whole, with the events it made. */
export function demoRequest(id: string): Json {
  const found = REQUESTS.find((row) => row.id === id);
  if (!found) {
    return { ok: false, error: { code: 'request_not_found', message: 'request not found' } };
  }
  return {
    ok: true,
    data: {
      request: {
        ...found,
        headers: { 'content-type': 'application/json', 'x-signature': '[redacted]' },
        query: {},
        body:
          found.status === 'accepted'
            ? { encoding: 'utf8', data: '{"id":500,"name":"chris"}', bytes: 25 }
            : null,
        bodyRedacted: false,
        deliveries: demoRequestDeliveries(id),
      },
    },
  };
}

/** `POST /requests/:id/replay`: the demo changes nothing, and says what a real replay would make. */
export const demoReplay = (): Json => ({ ok: true, data: { routes: 1, deliveries: 1 } });
