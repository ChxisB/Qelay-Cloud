import { json } from './server-action-pages.helpers';

export type Row = Record<string, unknown>;

/** One inbound source as the Control API sends it: no check, called "Shop checkout". */
export const source = (over: Row = {}) => ({
  id: 'src_1',
  name: 'Shop checkout',
  enabled: true,
  verification: { kind: 'none', header: null, username: null },
  signed: false,
  previousSecretUntil: null,
  rejectedDropped: 0,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...over,
});

/** One stored request as the list sends it: accepted, a small JSON body, from `src_1`. */
export const inboundRequest = (over: Row = {}) => ({
  id: '9',
  sourceId: 'src_1',
  receivedAt: 2_000,
  method: 'POST',
  contentType: 'application/json',
  status: 'accepted',
  cause: null,
  bodyBytes: 25,
  ...over,
});

/** The same request read on its own: with what was posted, and the events made from it. */
export const requestDetail = (over: Row = {}) => ({
  ...inboundRequest(),
  headers: { 'content-type': 'application/json', authorization: '[redacted]' },
  query: { page: '2' },
  body: { encoding: 'utf8', data: '{"id":500,"name":"chris"}', bytes: 25 },
  bodyRedacted: false,
  deliveries: [],
  ...over,
});

const notFound = (code: string) =>
  json({ ok: false, error: { code, message: code.replaceAll('_', ' ') } }, 404);

/**
 * The Control API's `/sources` and `/requests` for `serveGateway`: a list changed in place by an add, an edit,
 * a rotation or a remove. Null when the call is not one of theirs. A create and a rotation answer with the
 * token and secret shown once, the way the server does.
 */
export function answerSources(
  method: string,
  url: URL,
  init: RequestInit | undefined,
  sources: Row[],
  requests: Row[]
): Response | null {
  const [, area, id, action] = url.pathname.split('/');
  if (area !== 'sources' && area !== 'requests') return null;
  const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Row);
  if (area === 'requests') {
    if (id === undefined) {
      const status = url.searchParams.get('status');
      const from = url.searchParams.get('source');
      const rows = requests.filter(
        (row) =>
          (status === null || row.status === status) && (from === null || row.sourceId === from)
      );
      return json({ ok: true, data: { requests: rows, next: null } });
    }
    const found = requests.find((row) => row.id === id);
    if (!found) return notFound('request_not_found');
    if (action === 'replay') return json({ ok: true, data: { routes: 1, deliveries: 1 } }, 202);
    return json({ ok: true, data: { request: requestDetail(found) } });
  }
  if (id === undefined) {
    if (method === 'GET') return json({ ok: true, data: { sources } });
    const check = (body.verification ?? {}) as Row;
    const kind = (check.kind as string | undefined) ?? 'none';
    const added = source({
      name: body.name,
      id: `src_${sources.length + 1}`,
      verification: { kind, header: check.header ?? null, username: check.username ?? null },
      signed: kind !== 'none',
    });
    sources.push(added);
    const secret =
      kind === 'none' ? undefined : ((body.secret as string) ?? 'made-secret-0123456789');
    return json({ ok: true, data: { source: added, token: `qin_${'a'.repeat(43)}`, secret } }, 201);
  }
  const found = sources.find((row) => row.id === id);
  if (!found) return notFound('source_not_found');
  if (method === 'DELETE') sources.splice(sources.indexOf(found), 1);
  if (method === 'PATCH') Object.assign(found, body);
  if (action === 'rotate-secret')
    return json({ ok: true, data: { source: found, secret: 'new-secret-0123456789' } });
  if (action === 'rotate-token')
    return json({ ok: true, data: { source: found, token: `qin_${'b'.repeat(43)}` } });
  return json({ ok: true, data: method === 'GET' || method === 'PATCH' ? { source: found } : {} });
}
