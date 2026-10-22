import type { WebhookDestination } from '@qelay-cloud/core';

/** What an operator saves: a named address that webhooks can be made from. */
export interface DestinationSpec {
  /** Unique in the namespace, at most 80 characters. */
  readonly name: string;
  /** `http` has a `url`, `queue` a `target`; the kind cannot be changed later. */
  readonly kind: WebhookDestination;
  /** `http` only. The store checks the length; the address rules are `core`'s `validateWebhookUrl`. */
  readonly url?: string;
  /** `queue` only: a queue of this namespace. */
  readonly target?: string;
}

/** What `updateDestination` may change; a key that is present is set. The address key must fit the kind. */
export interface DestinationPatch {
  readonly name?: string;
  readonly url?: string;
  readonly target?: string;
}

export interface DestinationRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: WebhookDestination;
  /** `http` only, else null. */
  readonly url: string | null;
  /** `queue` only, else null. */
  readonly target: string | null;
  /** The webhooks made from it. */
  readonly connections: number;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}
