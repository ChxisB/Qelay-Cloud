import { lookup } from 'node:dns/promises';
import {
  deliveryBody,
  firstBlockedAddress,
  signWebhook,
  validateWebhookUrl,
  WEBHOOK_ERROR_CHARS,
  WEBHOOK_HEADERS,
  WEBHOOK_SCHEMA_VERSION,
} from '@qelay-cloud/core';
import type { WebhookUrlPolicy } from '@qelay-cloud/core';
import type { AttemptOutcome, ClaimedDelivery } from '@qelay-cloud/store-postgres';
import type { Destinations } from './webhookDestinations';
import type { Enqueue } from './webhookEnqueue';
import { enqueueDelivery } from './webhookEnqueue';
import type { PostFailure, PostFunction, PostResult } from './webhookHttp';
import { postOverSocket } from './webhookPool';

/**
 * One delivery attempt: the checks that keep a webhook from being a way into the network, then the
 * request. The order is the defence.
 *
 * 1. The URL is validated again (the row could predate a stricter policy, and it is cheap).
 * 2. The host is resolved here, once, and ALL its answers must be public. A name that has one public
 *    and one private record is refused, because the system resolver is free to pick either.
 * 3. The request goes to the address that was checked (`webhookHttp.ts`), never to the name, so the
 *    name cannot be re-pointed between the check and the connection (DNS rebinding). TLS is checked
 *    against the name.
 * 4. A redirect is not followed: it is a failed attempt. Following it would need the whole check
 *    again for a destination the operator never wrote, and a receiver that wants a new URL can be
 *    edited.
 *
 * What an attempt records is short text: the status the receiver answered, or a reason in words,
 * and for a failed answer the first bytes of its body when `captureBytes` is set (only a public
 * address is ever connected to, so that is a public receiver's own words; a sender that allows
 * private addresses leaves capture off unless asked). Never a resolved address (it would answer
 * "what does this internal name point to").
 */

/** How many of a name's addresses one attempt tries while the connection is refused. */
export const MAX_ADDRESSES_TRIED = 4;

export type Resolver = (host: string) => Promise<readonly string[]> | readonly string[];

/** The system resolver, every address of both families. */
export const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((answer) => answer.address);

/** Names kept at most; past it the oldest goes. */
const MAX_CACHED_NAMES = 1_024;

/**
 * `resolve`, with each name's answers kept for `ttlMs` and one lookup at a time per name, so a sender
 * doing thousands of deliveries a second to a few receivers does a few lookups, not thousands (a
 * cloud resolver caps the packets it takes from one machine). It keeps answers, not a verdict:
 * `sendDelivery` checks every answer it is given, cached or fresh, so a name that turns private is
 * refused on its next use after the entry expires. A failed lookup is not kept.
 * shortcut: no negative cache and no serving of an expired answer, add them if lookups to a dead name show up in the resolver's load.
 */
export function cachedResolver(
  resolve: Resolver,
  ttlMs: number,
  clock: () => number = () => performance.now()
): Resolver {
  const seen = new Map<
    string,
    { readonly until: number; readonly answers: Promise<readonly string[]> }
  >();
  return (host) => {
    const now = clock();
    const hit = seen.get(host);
    if (hit !== undefined && hit.until > now) return hit.answers;
    const entry = { until: now + ttlMs, answers: Promise.resolve().then(() => resolve(host)) };
    seen.set(host, entry);
    entry.answers.catch(() => {
      if (seen.get(host) === entry) seen.delete(host);
    });
    if (seen.size > MAX_CACHED_NAMES) seen.delete(seen.keys().next().value!);
    return entry.answers;
  };
}

export interface SendDeps {
  readonly urlPolicy: WebhookUrlPolicy;
  readonly resolve: Resolver;
  readonly post: PostFunction;
  /** Per-destination concurrency and breaker. Absent: none. */
  readonly destinations?: Destinations;
  /** Bound on the whole attempt: name lookup, connection, TLS and the receiver's answer. */
  readonly timeoutMs: number;
  /** Epoch milliseconds. The attempt's timestamp, header and history entry come from it. */
  readonly now: () => number;
  /** Extra trusted CA (PEM) for https receivers. */
  readonly ca?: string;
  /** Bytes of a failed answer's body kept in the attempt's history entry. Absent or 0: none. */
  readonly captureBytes?: number;
  /** The `User-Agent` header. Absent: `DEFAULT_USER_AGENT`. */
  readonly userAgent?: string;
  /** The store's `enqueue`, for `queue` routes. Absent: such a delivery fails and is retried. */
  readonly enqueue?: Enqueue;
}

export const defaultSendDeps = (
  urlPolicy: WebhookUrlPolicy,
  timeoutMs: number
): Pick<SendDeps, 'urlPolicy' | 'resolve' | 'post' | 'timeoutMs' | 'now'> => ({
  urlPolicy,
  resolve: systemResolver,
  post: postOverSocket,
  timeoutMs,
  now: Date.now,
});

const FAILURE_TEXT: Readonly<Record<PostFailure, string>> = {
  timeout: 'receiver did not answer in time',
  refused: 'connection failed',
  tls: 'TLS handshake failed or the certificate was not accepted',
  reset: 'connection closed before an answer',
  protocol: 'receiver did not answer with HTTP',
};

const cut = (text: string): string => text.slice(0, WEBHOOK_ERROR_CHARS);

/** Never rejects: whatever goes wrong is a failed attempt with a reason. */
export async function sendDelivery(
  delivery: ClaimedDelivery,
  deps: SendDeps
): Promise<AttemptOutcome> {
  const startedAt = deps.now();
  const clock = performance.now();
  const outcome = (
    ok: boolean,
    statusCode: number | null,
    error: string | null,
    response: string | null = null
  ): AttemptOutcome => ({
    deliveryId: delivery.deliveryId,
    webhookId: delivery.webhookId,
    attempt: delivery.attempt,
    ok,
    statusCode,
    error: error === null ? null : cut(error),
    response,
    startedAt,
    durationMs: Math.max(0, Math.round(performance.now() - clock)),
  });
  const refuse = (reason: string) => outcome(false, null, reason);
  try {
    if (delivery.destination === 'queue') {
      return await enqueueDelivery(delivery, deps.enqueue, (ok, error) => outcome(ok, null, error));
    }
    // A signed webhook whose secret cannot be opened is not sent unsigned: that would hand the
    // receiver an unauthenticated request it was set up to reject, or worse, to accept.
    if (delivery.secretUnreadable) return refuse('signing secret could not be opened');
    const verdict = validateWebhookUrl(delivery.url, deps.urlPolicy);
    if (!verdict.ok) return refuse(`destination not allowed (${verdict.code})`);

    const deadline = clock + deps.timeoutMs;
    const remaining = (): number => Math.max(0, Math.floor(deadline - performance.now()));
    let addresses: readonly string[];
    if (verdict.literal) {
      addresses = [verdict.host];
    } else {
      try {
        addresses = await within(Promise.resolve(deps.resolve(verdict.host)), remaining());
      } catch {
        return refuse('name did not resolve');
      }
    }
    if (addresses.length === 0) return refuse('name did not resolve');
    if (!deps.urlPolicy.allowPrivate && firstBlockedAddress(addresses) !== null) {
      return refuse('destination not allowed: the name resolves to a non-public address');
    }

    // The delivery writer shapes a body once and stores it: every attempt sends and signs those bytes.
    if (delivery.body === '') return refuse('shaped body was too large to make');
    const body =
      delivery.body ??
      deliveryBody({
        id: delivery.deliveryId,
        event: delivery.event,
        occurredAt: delivery.occurredAt,
        queue: delivery.queue,
        jobId: delivery.jobId,
        state: delivery.state,
        error: delivery.error,
        progress: delivery.progress,
      });
    const timestamp = deps.now();
    const headers: Record<string, string> = {
      [WEBHOOK_HEADERS.id]: delivery.deliveryId,
      [WEBHOOK_HEADERS.event]: delivery.event,
      [WEBHOOK_HEADERS.timestamp]: String(timestamp),
      [WEBHOOK_HEADERS.attempt]: String(delivery.attempt),
      ...(delivery.body === null ? { [WEBHOOK_HEADERS.schema]: WEBHOOK_SCHEMA_VERSION } : {}),
    };
    if (delivery.secret !== null) {
      // During a rotation both secrets sign (comma-separated), so a receiver holding either verifies.
      const secrets = [
        delivery.secret,
        ...(delivery.previousSecret === null ? [] : [delivery.previousSecret]),
      ];
      headers[WEBHOOK_HEADERS.signature] = (
        await Promise.all(secrets.map((secret) => signWebhook(secret, timestamp, body)))
      ).join(',');
    }
    const { url } = verdict;
    const secure = url.protocol === 'https:';

    const key = `${verdict.host}:${verdict.port}`;
    const entry =
      deps.destinations === undefined ? null : await deps.destinations.enter(key, remaining());
    if (entry === 'open') return refuse('destination paused: it failed several attempts in a row');
    if (entry === 'busy') return refuse('destination busy: too many requests in flight to it');

    let result: PostResult = { kind: 'failed', failure: 'refused' };
    try {
      for (const address of addresses.slice(0, MAX_ADDRESSES_TRIED)) {
        const budget = remaining();
        if (budget === 0) {
          result = { kind: 'failed', failure: 'timeout' };
          break;
        }
        result = await deps.post({
          address,
          port: verdict.port,
          secure,
          ...(verdict.literal ? {} : { serverName: verdict.host }),
          hostHeader: url.host,
          path: `${url.pathname}${url.search}`,
          headers,
          body,
          timeoutMs: budget,
          ...(deps.ca === undefined ? {} : { ca: deps.ca }),
          ...(deps.captureBytes ? { captureBytes: deps.captureBytes } : {}),
          ...(deps.userAgent === undefined ? {} : { userAgent: deps.userAgent }),
        });
        // Only a refused connection is worth another address: anything else reached a host.
        if (result.kind === 'status' || result.failure !== 'refused') break;
      }
    } finally {
      entry?.leave(result.kind === 'status' && result.status < 500 && result.status !== 429);
    }
    return result.kind === 'status'
      ? answered(result, outcome)
      : refuse(FAILURE_TEXT[result.failure]);
  } catch {
    // A bug or a driver error must cost this attempt, not the others in its batch. Nothing of the
    // error is recorded: it could carry a path or an address.
    return refuse('the attempt could not be made');
  }
}

function answered(
  result: { readonly status: number; readonly body?: string },
  outcome: (
    ok: boolean,
    statusCode: number | null,
    error: string | null,
    response?: string | null
  ) => AttemptOutcome
): AttemptOutcome {
  const { status, body } = result;
  if (status >= 200 && status < 300) return outcome(true, status, null);
  if (status >= 300 && status < 400)
    return outcome(false, status, `redirect not followed (${status})`, body);
  return outcome(false, status, `receiver answered ${status}`, body);
}

/** `promise`, or a rejection after `ms`. The late result of `promise` is ignored. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('failed'));
      }
    );
  });
}
