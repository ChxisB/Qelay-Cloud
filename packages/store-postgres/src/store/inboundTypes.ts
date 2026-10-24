import type {
  SourceVerification,
  SourceVerificationKind,
  WebhookDestination,
} from '@qelay-cloud/core';
import type { DeliveryRecord } from './webhookTypes';

/** How a source is asked to check who posts to it. The secret is never part of it: see `SourceSpec.secret`. */
export interface SourceVerificationInput {
  readonly kind: SourceVerificationKind;
  /** `hmac` and `api_key`: the header that carries the signature or the key. */
  readonly header?: string | null;
  /** `basic`: the user name; the secret is the password. */
  readonly username?: string | null;
}

/** What an operator registers. */
export interface SourceSpec {
  /** Unique in the namespace, 1 to 80 characters. */
  readonly name: string;
  /** Default `none`: anyone with the URL can post. */
  readonly verification?: SourceVerificationInput | null;
  /**
   * The shared secret, in the clear and only here: the store seals it (`webhookKey`). Null or omitted: the store makes one
   * for a source that verifies (`SourceIssued.secret`). A `none` source has no secret.
   */
  readonly secret?: string | null;
  /** Default true. A disabled source answers 404, as one that does not exist. */
  readonly enabled?: boolean;
}

/** What `update` may change. Verification is not editable: make another source and move the routes to it. */
export interface SourcePatch {
  readonly name?: string;
  readonly enabled?: boolean;
}

/** A source as listings show it. Neither the token nor the secret is part of it: `signed` says there is a secret. */
export interface SourceRecord {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly verification: SourceVerification;
  readonly signed: boolean;
  /** While a rotated-out secret still verifies beside the new one: until when (epoch ms). */
  readonly previousSecretUntil: number | null;
  /** Rejected requests that were counted and not stored, for being over the per-minute cap. */
  readonly rejectedDropped: number;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * What `create`, `rotateSecret` and `rotateToken` return: the source, and what the store made for it. That is the one time
 * they are shown. `token` is the URL token (`create` and `rotateToken`); `secret` is the secret the store made, null when
 * the caller chose it or the source does not verify.
 */
export interface SourceIssued extends SourceRecord {
  readonly token: string | null;
  readonly secret: string | null;
}

/** What the ingest needs to judge a request to a source: found by the URL token, with the secret opened. */
export interface SourceAuth {
  readonly id: string;
  readonly enabled: boolean;
  readonly verification: SourceVerification;
  /** Null for a `none` source, and when `secretUnreadable`. */
  readonly secret: string | null;
  /** The secret before the last rotation while it still verifies; null otherwise. */
  readonly previousSecret: string | null;
  /** The source verifies but its secret could not be opened (no key, or the wrong one): accept nothing. */
  readonly secretUnreadable: boolean;
}

/** One inbound call as the ingest hands it over. The store redacts and clips the headers and the query. */
export interface InboundRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly contentType: string | null;
  /** At most `MAX_REQUEST_BODY_BYTES`. */
  readonly body: Uint8Array;
}

export type AcceptResult =
  /** Stored, with `deliveries` made out of `routes` enabled routes (a filter or a dedupe drops some). */
  | {
      readonly outcome: 'accepted';
      readonly id: string;
      readonly routes: number;
      readonly deliveries: number;
    }
  /** The source was removed or disabled since the ingest looked it up. Nothing was stored. */
  | { readonly outcome: 'unavailable' };

export interface RejectResult {
  /** False: the source is over its per-minute cap of stored rejections (counted in `rejectedDropped`), or it is gone. */
  readonly stored: boolean;
}

/** `requests.list`: newest first. `before` is the `next` of the page before. */
export interface RequestQuery {
  readonly sourceId?: string;
  readonly status?: 'accepted' | 'rejected';
  readonly before?: string;
  /** 1 to `MAX_DELIVERY_PAGE`, default `DEFAULT_DELIVERY_PAGE`. */
  readonly limit?: number;
}

/** A request as the list shows it: no headers, no query and no body. */
export interface RequestSummary {
  readonly id: string;
  readonly sourceId: string;
  readonly receivedAt: number;
  readonly method: string;
  readonly contentType: string | null;
  readonly status: 'accepted' | 'rejected';
  /** Why a rejected request was refused; null for an accepted one. */
  readonly cause: string | null;
  /** The size of the stored body; null for a rejected request, which keeps none. */
  readonly bodyBytes: number | null;
}

export interface RequestPage {
  readonly items: RequestSummary[];
  /** The `before` of the next page; null at the end. */
  readonly next: string | null;
}

/** One request whole: what was stored of it (headers redacted) and the deliveries it made. */
export interface RequestDetail extends RequestSummary {
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  /** Null for a rejected request. */
  readonly body: Uint8Array | null;
  /** Newest first. A replay adds to them. */
  readonly deliveries: Array<{
    readonly delivery: DeliveryRecord;
    readonly via: WebhookDestination;
  }>;
}

export type ReplayResult =
  /** New deliveries were made out of the source's `routes` enabled routes (a filter drops some). */
  | { readonly outcome: 'replayed'; readonly routes: number; readonly deliveries: number }
  | { readonly outcome: 'not_found' }
  /** A rejected request kept no body, so there is nothing to send. */
  | { readonly outcome: 'rejected' };
