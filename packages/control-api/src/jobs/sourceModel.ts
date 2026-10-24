import { VERIFICATION_KINDS } from '@qelay-cloud/core';
import type { SourceVerification, WebhookDestination } from '@qelay-cloud/core';
import type {
  RequestDetail,
  RequestSummary,
  SourceIssued,
  SourceRecord,
} from '@qelay-cloud/store-postgres';
import { MAX_DELIVERY_PAGE, MAX_SECRET_CHARS } from '@qelay-cloud/store-postgres';
import { z } from 'zod';
import type { Role } from '../types';
import type { DeliveryWire } from './deliveryWire';
import { toDeliveryWire } from './deliveryWire';

/**
 * Inbound sources and the requests they took (DESIGN.md D12 and D14) as the console reads and writes them. A source's URL
 * token and secret are shown once, in the response that made them, and in no read. The bounds here only keep a body small:
 * the store (core's `validateVerification` and the others) names the exact rule a value breaks.
 */

const requestId = z.string().regex(/^[1-9]\d{0,15}$/u);

/** `POST /sources`. No `verification` is `none`: anyone with the URL can post. No `secret` has the store make one. */
export const sourceBody = z.strictObject({
  name: z.string().max(1_000),
  verification: z
    .strictObject({
      kind: z.enum(VERIFICATION_KINDS),
      header: z.string().max(256).nullable().optional(),
      username: z.string().max(256).nullable().optional(),
    })
    .optional(),
  secret: z.string().max(MAX_SECRET_CHARS).nullable().optional(),
  enabled: z.boolean().optional(),
});

/** `PATCH /sources/:id`. Verification is not editable: make another source and move the routes to it. */
export const sourcePatchBody = z.strictObject({
  name: z.string().max(1_000).optional(),
  enabled: z.boolean().optional(),
});

/** `POST /sources/:id/rotate-secret`: the new secret, or none to have one made. The body may be left out. */
export const sourceRotateBody = z.strictObject({
  secret: z.string().max(MAX_SECRET_CHARS).nullable().optional(),
});

/** `GET /requests`: newest first, `before` being the `next` of the page before. */
export const requestsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_DELIVERY_PAGE).optional(),
  before: requestId.optional(),
  source: z.string().min(1).max(256).optional(),
  status: z.enum(['accepted', 'rejected']).optional(),
});

export interface SourceWire {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly verification: SourceVerification;
  /** True when there is a secret. The secret itself is never read back. */
  readonly signed: boolean;
  /** While a rotated-out secret still verifies beside the new one: when it stops. */
  readonly previousSecretUntil: number | null;
  /** Rejected requests counted and not stored, for being over the per-minute cap. */
  readonly rejectedDropped: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** No subject goes out (`createdBy` stays in the store). */
export const toSourceWire = (source: SourceRecord): SourceWire => ({
  id: source.id,
  name: source.name,
  enabled: source.enabled,
  verification: source.verification,
  signed: source.signed,
  previousSecretUntil: source.previousSecretUntil,
  rejectedDropped: source.rejectedDropped,
  createdAt: source.createdAt,
  updatedAt: source.updatedAt,
});

/** `data` of a create or a rotation: the source, and what was made for it, shown this once. */
export const toIssuedSourceWire = (
  source: SourceIssued
): { source: SourceWire; token?: string; secret?: string } => ({
  source: toSourceWire(source),
  ...(source.token === null ? {} : { token: source.token }),
  ...(source.secret === null ? {} : { secret: source.secret }),
});

export interface RequestWire {
  readonly id: string;
  readonly sourceId: string;
  readonly receivedAt: number;
  readonly method: string;
  readonly contentType: string | null;
  readonly status: 'accepted' | 'rejected';
  /** Why a rejected request was refused; null for an accepted one. */
  readonly cause: string | null;
  /** The stored body's size; null for a rejected request, which keeps none. */
  readonly bodyBytes: number | null;
}

export const toRequestWire = (request: RequestSummary): RequestWire => ({
  id: request.id,
  sourceId: request.sourceId,
  receivedAt: request.receivedAt,
  method: request.method,
  contentType: request.contentType,
  status: request.status,
  cause: request.cause,
  bodyBytes: request.bodyBytes,
});

export interface BodyWire {
  /** `utf8` when the bytes are text, `base64` when they are not. */
  readonly encoding: 'utf8' | 'base64';
  readonly data: string;
  readonly bytes: number;
}

export interface RequestDetailWire extends RequestWire {
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  /** Null for a rejected request, and for a caller who may only read (`bodyRedacted`). */
  readonly body: BodyWire | null;
  /** True when the request has a body that this caller is not shown. */
  readonly bodyRedacted: boolean;
  readonly deliveries: Array<DeliveryWire & { readonly via: WebhookDestination }>;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function bodyOf(bytes: Uint8Array): BodyWire {
  try {
    return { encoding: 'utf8', data: utf8.decode(bytes), bytes: bytes.byteLength };
  } catch {
    return {
      encoding: 'base64',
      data: Buffer.from(bytes).toString('base64'),
      bytes: bytes.byteLength,
    };
  }
}

/** A body can hold what the sender chose to send, so only an operator reads it; headers are redacted by the store. */
export function toRequestDetailWire(request: RequestDetail, role: Role): RequestDetailWire {
  const shown = role === 'operator' && request.body !== null;
  return {
    ...toRequestWire(request),
    headers: request.headers,
    query: request.query,
    body: shown ? bodyOf(request.body!) : null,
    bodyRedacted: request.body !== null && !shown,
    deliveries: request.deliveries.map(({ delivery, via }) => ({
      ...toDeliveryWire(delivery, via),
      via,
    })),
  };
}
