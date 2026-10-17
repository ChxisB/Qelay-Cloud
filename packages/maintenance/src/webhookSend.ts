import { lookup } from 'node:dns/promises';
import {
  deliveryBody,
  firstBlockedAddress,
  signWebhook,
  validateWebhookUrl,
  WEBHOOK_ERROR_CHARS,
  WEBHOOK_HEADERS,
} from '@qelay-cloud/core';
import type { WebhookUrlPolicy } from '@qelay-cloud/core';
import type { AttemptOutcome, ClaimedDelivery } from '@qelay-cloud/store-postgres';
import type { PostFailure, PostFunction } from './webhookHttp';
import { postOverSocket } from './webhookHttp';

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
 * What an attempt records is short and fixed text: the status the receiver answered, or a reason in
 * words. Never a response body (a webhook pointed at an internal service would turn the delivery
 * history into a way to read it) and never a resolved address (it would answer "what does this
 * internal name point to").
 */

/** How many of a name's addresses one attempt tries while the connection is refused. */
export const MAX_ADDRESSES_TRIED = 4;

export type Resolver = (host: string) => Promise<readonly string[]> | readonly string[];

/** The system resolver, every address of both families. */
export const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((answer) => answer.address);

export interface SendDeps {
  readonly urlPolicy: WebhookUrlPolicy;
  readonly resolve: Resolver;
  readonly post: PostFunction;
  /** Bound on the whole attempt: name lookup, connection, TLS and the receiver's answer. */
  readonly timeoutMs: number;
  /** Epoch milliseconds. The attempt's timestamp, header and history entry come from it. */
  readonly now: () => number;
  /** Extra trusted CA (PEM) for https receivers. */
  readonly ca?: string;
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
    error: string | null
  ): AttemptOutcome => ({
    deliveryId: delivery.deliveryId,
    webhookId: delivery.webhookId,
    attempt: delivery.attempt,
    ok,
    statusCode,
    error: error === null ? null : cut(error),
    startedAt,
    durationMs: Math.max(0, Math.round(performance.now() - clock)),
  });
  const refuse = (reason: string) => outcome(false, null, reason);
  try {
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

    const body = deliveryBody({
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
    };
    if (delivery.secret !== null) {
      headers[WEBHOOK_HEADERS.signature] = await signWebhook(delivery.secret, timestamp, body);
    }
    const { url } = verdict;
    const secure = url.protocol === 'https:';

    let last: PostFailure = 'refused';
    for (const address of addresses.slice(0, MAX_ADDRESSES_TRIED)) {
      const budget = remaining();
      if (budget === 0) return refuse(FAILURE_TEXT.timeout);
      const result = await deps.post({
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
      });
      if (result.kind === 'status') return answered(result.status, outcome);
      last = result.failure;
      // Only a refused connection is worth another address: anything else reached a host.
      if (last !== 'refused') break;
    }
    return refuse(FAILURE_TEXT[last]);
  } catch {
    // A bug or a driver error must cost this attempt, not the others in its batch. Nothing of the
    // error is recorded: it could carry a path or an address.
    return refuse('the attempt could not be made');
  }
}

function answered(
  status: number,
  outcome: (ok: boolean, statusCode: number | null, error: string | null) => AttemptOutcome
): AttemptOutcome {
  if (status >= 200 && status < 300) return outcome(true, status, null);
  if (status >= 300 && status < 400)
    return outcome(false, status, `redirect not followed (${status})`);
  return outcome(false, status, `receiver answered ${status}`);
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
