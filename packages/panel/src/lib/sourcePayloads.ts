import type {
  ReplayResult,
  RequestDetailFull,
  RequestFull,
  RequestsPage,
  SourceFull,
  SourceIssued,
} from './bq/gatewayTypes';
import { wellFormedDelivery } from './dashboardPayloads';
import { count, optionalText, payloadData, record, text, timestamp } from './payloadChecks';

/**
 * The inbound-source payloads: sources, the requests they took and a replay. Each is checked before a screen
 * draws it, as the other gateway payloads are, and a malformed one is refused whole.
 */

const MAX_SOURCES = 1_000;
const MAX_REQUESTS = 200;
const MAX_PAIRS = 256;
const MAX_VALUE_CHARS = 2_048;
const MAX_BODY_CHARS = 1_048_576;
const REQUEST_ID = /^[1-9]\d{0,15}$/u;
const KINDS = new Set<unknown>(['none', 'hmac', 'basic', 'api_key']);
const METHODS = new Set<unknown>(['POST', 'PUT', 'PATCH', 'DELETE']);

function sourceOf(value: unknown): value is SourceFull {
  const one = record(value);
  const verification = record(one?.verification);
  return (
    one !== null &&
    verification !== null &&
    text(one.id, 1_024) &&
    text(one.name, 1_000) &&
    typeof one.enabled === 'boolean' &&
    KINDS.has(verification.kind) &&
    optionalText(verification.header, 256) &&
    optionalText(verification.username, 256) &&
    typeof one.signed === 'boolean' &&
    (one.previousSecretUntil === null || timestamp(one.previousSecretUntil)) &&
    count(one.rejectedDropped) &&
    timestamp(one.createdAt) &&
    timestamp(one.updatedAt)
  );
}

/** `GET /sources`. */
export function parseSourcesPayload(value: unknown): SourceFull[] {
  const data = payloadData(value, 'sources');
  if (
    !Array.isArray(data.sources) ||
    data.sources.length > MAX_SOURCES ||
    !data.sources.every(sourceOf) ||
    new Set(data.sources.map((one) => one.id)).size !== data.sources.length
  ) {
    throw new Error('Malformed sources response.');
  }
  return data.sources;
}

/** The answer to a create, a rotation or an edit: the source, and the token or secret shown once. */
export function parseSourceIssuedPayload(value: unknown): SourceIssued {
  const data = payloadData(value, 'source');
  const { source, token, secret } = data;
  if (
    !sourceOf(source) ||
    !(token === undefined || text(token, 256)) ||
    !(secret === undefined || text(secret, 1_024))
  ) {
    throw new Error('Malformed source response.');
  }
  return { source, token: token ?? null, secret: secret ?? null };
}

function requestOf(value: unknown): value is RequestFull {
  const one = record(value);
  return (
    one !== null &&
    typeof one.id === 'string' &&
    REQUEST_ID.test(one.id) &&
    text(one.sourceId, 1_024) &&
    timestamp(one.receivedAt) &&
    METHODS.has(one.method) &&
    optionalText(one.contentType, 512) &&
    (one.status === 'accepted' || one.status === 'rejected') &&
    optionalText(one.cause, 512) &&
    (one.bodyBytes === null || count(one.bodyBytes))
  );
}

/** `GET /requests`: one page, newest first. */
export function parseRequestsPayload(value: unknown): RequestsPage {
  const data = payloadData(value, 'requests');
  if (
    !Array.isArray(data.requests) ||
    data.requests.length > MAX_REQUESTS ||
    !data.requests.every(requestOf) ||
    new Set(data.requests.map((one) => one.id)).size !== data.requests.length ||
    !(data.next === null || (typeof data.next === 'string' && REQUEST_ID.test(data.next)))
  ) {
    throw new Error('Malformed requests response.');
  }
  return { requests: data.requests, next: data.next };
}

/** Header and query values are what a stranger sent: any text up to the stored length, drawn as text only. */
function pairsOf(value: unknown): value is Record<string, string> {
  const pairs = record(value);
  return (
    pairs !== null &&
    Object.keys(pairs).length <= MAX_PAIRS &&
    Object.entries(pairs).every(
      ([key, one]) => key.length <= 256 && typeof one === 'string' && one.length <= MAX_VALUE_CHARS
    )
  );
}

function bodyOf(value: unknown): boolean {
  if (value === null) return true;
  const body = record(value);
  return (
    body !== null &&
    (body.encoding === 'utf8' || body.encoding === 'base64') &&
    typeof body.data === 'string' &&
    body.data.length <= MAX_BODY_CHARS &&
    count(body.bytes)
  );
}

function deliveriesOf(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_REQUESTS &&
    value.every((candidate) => {
      const delivery = record(candidate);
      return (
        delivery !== null &&
        wellFormedDelivery(delivery) &&
        (delivery.via === 'http' || delivery.via === 'queue')
      );
    })
  );
}

/** `GET /requests/:id`. */
export function parseRequestDetailPayload(value: unknown): RequestDetailFull {
  const one = record(payloadData(value, 'request').request);
  if (
    one === null ||
    !requestOf(one) ||
    !pairsOf(one.headers) ||
    !pairsOf(one.query) ||
    !bodyOf(one.body) ||
    typeof one.bodyRedacted !== 'boolean' ||
    !deliveriesOf(one.deliveries)
  ) {
    throw new Error('Malformed request response.');
  }
  return one as unknown as RequestDetailFull;
}

/** `POST /requests/:id/replay`. */
export function parseReplayPayload(value: unknown): ReplayResult {
  const data = payloadData(value, 'replay');
  if (!count(data.routes) || !count(data.deliveries)) throw new Error('Malformed replay response.');
  return { routes: data.routes, deliveries: data.deliveries };
}
