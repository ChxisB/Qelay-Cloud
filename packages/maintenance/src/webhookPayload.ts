import { deliveryBody, isJsonContentType } from '@qelay-cloud/core';
import type { ClaimedDelivery } from '@qelay-cloud/store-postgres';

/**
 * What one delivery sends (D14): the body the route's shape made, stored on the delivery; else the request's own bytes with
 * its content type; else (a test delivery, which no request made) Qelay's small test document. Signing covers exactly the
 * bytes sent.
 */

export interface Payload {
  /** The text sent; empty when `bytes` is. */
  readonly text: string;
  /** The request's own bytes, sent as they came in. */
  readonly bytes?: Uint8Array;
  readonly contentType?: string;
  /** What the signature covers: the exact bytes on the wire. */
  readonly signed: string | Uint8Array;
  /** True for Qelay's own test document, which carries `X-Webhook-Schema`. */
  readonly testDocument: boolean;
}

export type PayloadResult =
  | { readonly ok: true; readonly payload: Payload }
  | { readonly ok: false; readonly reason: string };

/** Printable ASCII only: a content type is copied into a header line, so a CR or LF must never get through. */
const HEADER_SAFE = /^[ -~]+$/u;
export const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

export const safeContentType = (contentType: string | null): string =>
  contentType !== null && HEADER_SAFE.test(contentType) ? contentType : FALLBACK_CONTENT_TYPE;

export function deliveryPayload(delivery: ClaimedDelivery): PayloadResult {
  // A shape is applied once, when the request is taken, and stored: every attempt sends and signs those bytes.
  if (delivery.body === '') return { ok: false, reason: 'shaped body was too large to make' };
  if (delivery.body !== null) {
    return {
      ok: true,
      payload: { text: delivery.body, signed: delivery.body, testDocument: false },
    };
  }
  if (delivery.requestId !== null) {
    if (delivery.requestBody === null)
      return { ok: false, reason: 'the request is no longer stored' };
    return {
      ok: true,
      payload: {
        text: '',
        bytes: delivery.requestBody,
        contentType: safeContentType(delivery.requestContentType),
        signed: delivery.requestBody,
        testDocument: false,
      },
    };
  }
  const text = deliveryBody({
    id: delivery.deliveryId,
    event: delivery.event,
    occurredAt: delivery.occurredAt,
  });
  return { ok: true, payload: { text, signed: text, testDocument: true } };
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** A `queue` route's job data: the JSON the body holds, else its text. `null` when the bytes are not text. */
export function jobData(delivery: ClaimedDelivery, payload: Payload): { data: unknown } | null {
  if (payload.bytes === undefined) return { data: JSON.parse(payload.text) };
  let text: string;
  try {
    text = utf8.decode(payload.bytes);
  } catch {
    return null;
  }
  if (!isJsonContentType(delivery.requestContentType)) return { data: text };
  try {
    return { data: JSON.parse(text) };
  } catch {
    return { data: text };
  }
}
