import type { StoreContext } from './context';
import { acceptRequest, rejectRequest } from './inboundAccept';
import { findSourceByToken, rotateSourceSecret, rotateSourceToken } from './inboundCredentials';
import { getRequest, listRequests, replayRequest } from './inboundRequests';
import { createSource, deleteSource, getSource, listSources, updateSource } from './inboundSources';
import type {
  AcceptResult,
  InboundRequest,
  RejectResult,
  ReplayResult,
  RequestDetail,
  RequestPage,
  RequestQuery,
  SourceAuth,
  SourceIssued,
  SourcePatch,
  SourceRecord,
  SourceSpec,
} from './inboundTypes';

/** Inbound sources (`store.sources`, D12 and D14): the operator's side, and the calls the ingest makes. */
export interface SourceApi {
  /**
   * Registers a source. `createdBy` is the operator's subject. Returns the URL token and, for a source that verifies, the
   * secret the store made (or the one given): shown once. Throws `SourceLimitError` at the cap, `SourceNameTakenError` for
   * a name in use and `WebhookKeyError` for a verifying source when the store has no `webhookKey`.
   */
  create(spec: SourceSpec, createdBy: string): Promise<SourceIssued>;
  list(): Promise<SourceRecord[]>;
  get(id: string): Promise<SourceRecord | null>;
  /** Renames or turns it on or off. Null when there is no such source. */
  update(id: string, patch: SourcePatch): Promise<SourceRecord | null>;
  /** The old secret keeps verifying for `WEBHOOK_SECRET_GRACE_MS`. Null when there is no such source. */
  rotateSecret(id: string, secret?: string | null): Promise<SourceIssued | null>;
  /** The old URL stops working at once. Null when there is no such source. */
  rotateToken(id: string): Promise<SourceIssued | null>;
  /** Throws `SourceInUseError` while a route still listens to it. False when there was none. */
  delete(id: string): Promise<boolean>;
  /** What the ingest needs to judge a request to the URL with this token; null for a token that is not one. */
  findByToken(token: string): Promise<SourceAuth | null>;
  /** Stores a request that passed and makes a delivery for each of its routes. */
  accept(sourceId: string, request: InboundRequest): Promise<AcceptResult>;
  /** Stores a request that did not pass, with its cause, within the source's per-minute cap. */
  reject(sourceId: string, request: InboundRequest, cause: string): Promise<RejectResult>;
  /** Stored requests, newest first, by keyset (`RequestQuery`). */
  requests(query?: RequestQuery): Promise<RequestPage>;
  /** One request with its headers, query, body and deliveries. Null when there is none (also once retention removed it). */
  request(id: string): Promise<RequestDetail | null>;
  /** Makes new deliveries for the source's routes as they are now; see `replayRequest`. */
  replay(id: string): Promise<ReplayResult>;
}

export const sourceApi = (ctx: StoreContext): SourceApi => ({
  create: (spec, createdBy) => createSource(ctx, spec, createdBy),
  list: () => listSources(ctx),
  get: (id) => getSource(ctx, id),
  update: (id, patch) => updateSource(ctx, id, patch),
  rotateSecret: (id, secret) => rotateSourceSecret(ctx, id, secret),
  rotateToken: (id) => rotateSourceToken(ctx, id),
  delete: (id) => deleteSource(ctx, id),
  findByToken: (token) => findSourceByToken(ctx, token),
  accept: (sourceId, request) => acceptRequest(ctx, sourceId, request),
  reject: (sourceId, request, cause) => rejectRequest(ctx, sourceId, request, cause),
  requests: (query) => listRequests(ctx, query),
  request: (id) => getRequest(ctx, id),
  replay: (id) => replayRequest(ctx, id),
});
