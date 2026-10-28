import type { SourceAuth } from '@qelay-cloud/store-postgres';
import type { IngestLimits, IngestStore } from '../src';
import { createIngestHandler, DEFAULT_LIMITS } from '../src';

export const TOKEN = `qin_${'a'.repeat(43)}`;
export const PATH = `/s/${TOKEN}`;

export const NONE: SourceAuth = {
  id: 'src_1',
  enabled: true,
  verification: { kind: 'none', header: null, username: null },
  secret: null,
  previousSecret: null,
  secretUnreadable: false,
};

export interface Calls {
  readonly lookups: string[];
  readonly accepted: Array<{ sourceId: string; request: Parameters<IngestStore['accept']>[1] }>;
  readonly rejected: Array<{
    sourceId: string;
    request: Parameters<IngestStore['reject']>[1];
    cause: string;
  }>;
}

/** A store that knows one source (or none) and writes down what the ingest asked of it. */
export function stubStore(
  source: SourceAuth | null = NONE,
  over: Partial<IngestStore> = {}
): { store: IngestStore; calls: Calls } {
  const calls: Calls = { lookups: [], accepted: [], rejected: [] };
  const store: IngestStore = {
    findByToken: async (token) => {
      calls.lookups.push(token);
      return source;
    },
    accept: async (sourceId, request) => {
      calls.accepted.push({ sourceId, request });
      return { outcome: 'accepted', id: 'req_1', routes: 1, deliveries: 1 };
    },
    reject: async (sourceId, request, cause) => {
      calls.rejected.push({ sourceId, request, cause });
      return { stored: true };
    },
    ...over,
  };
  return { store, calls };
}

export const limits = (over: Partial<IngestLimits> = {}): IngestLimits => ({
  ...DEFAULT_LIMITS,
  ...over,
});

export const handlerFor = (store: IngestStore, over: Partial<IngestLimits> = {}) =>
  createIngestHandler({ store, limits: limits(over) });

export interface Sent {
  readonly status: number;
  readonly text: string;
  readonly headers: Headers;
}

export interface Send {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Record<string, string>;
  readonly body?: RequestInit['body'];
}

/** One request through a handler, as a `Request` with no network between. */
export async function send(
  handler: (request: Request) => Promise<Response>,
  { method = 'POST', path = PATH, headers = {}, body = null }: Send = {}
): Promise<Sent> {
  const init: RequestInit & { duplex?: 'half' } = { method, headers, duplex: 'half' };
  if (body !== null && method !== 'GET' && method !== 'HEAD') init.body = body;
  const response = await handler(new Request(`http://ingest.test${path}`, init));
  return { status: response.status, text: await response.text(), headers: response.headers };
}

/** A body that sends `count` chunks of `size` bytes and ends. */
export const chunks = (count: number, size: number): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (let i = 0; i < count; i += 1) controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });

/** A body that never sends a byte and never ends. */
export const hang = (): ReadableStream<Uint8Array> =>
  new ReadableStream({ pull: () => new Promise(() => {}) });
