import { MAX_WEBHOOK_URL_CHARS, WEBHOOK_DESTINATIONS } from '@qelay-cloud/core';
import type { WebhookDestination } from '@qelay-cloud/core';
import type { DestinationRecord } from '@qelay-cloud/store-postgres';
import { z } from 'zod';
import type { Role } from '../types';
import { shownUrl } from './webhookModel';

/**
 * Saved destinations as the Destinations screen reads and writes them (`docs/event-gateway.md`): a named `http` address or
 * `queue` target that connections are made from. The bounds here only keep a body small; the store names the exact rule a
 * value breaks. A destination holds no secret: each connection signs with its own.
 */

/** `POST /webhooks/destinations`. `url` belongs to `http` and `target` to `queue`; the store says which is missing. */
export const destinationBody = z.strictObject({
  name: z.string().max(1_000),
  kind: z.enum(WEBHOOK_DESTINATIONS),
  url: z.string().max(MAX_WEBHOOK_URL_CHARS).optional(),
  target: z.string().max(256).optional(),
});

/** `PATCH /webhooks/destinations/:id`: the kind is fixed, so `url` is for an `http` destination and `target` for a `queue` one. */
export const destinationPatchBody = z.strictObject({
  name: z.string().max(1_000).optional(),
  url: z.string().max(MAX_WEBHOOK_URL_CHARS).optional(),
  target: z.string().max(256).optional(),
});

export interface DestinationWire {
  readonly id: string;
  readonly name: string;
  readonly kind: WebhookDestination;
  /** The address of an `http` destination; empty for `queue`. Only its origin to a read-only caller, as on a webhook. */
  readonly url: string;
  readonly urlRedacted: boolean;
  /** The queue of a `queue` destination; null for `http`. */
  readonly target: string | null;
  /** The connections made from it. */
  readonly connections: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** No subject goes out (`createdBy` stays in the store), and the URL is redacted for a caller who may only read. */
export function toDestinationWire(destination: DestinationRecord, role: Role): DestinationWire {
  return {
    id: destination.id,
    name: destination.name,
    kind: destination.kind,
    ...shownUrl(destination.url ?? '', role),
    target: destination.target,
    connections: destination.connections,
    createdAt: destination.createdAt,
    updatedAt: destination.updatedAt,
  };
}
