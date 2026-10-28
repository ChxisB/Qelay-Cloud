import {
  clipPairs,
  clipText,
  MAX_REJECTED_PER_MINUTE,
  MAX_REQUEST_BODY_BYTES,
  REJECT_WINDOW_MS,
  requestDocument,
  UnsupportedOptionError,
} from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { fanOut } from './inboundFanOut';
import type { AcceptResult, InboundRequest, RejectResult } from './inboundTypes';
import { identifier } from './prepare';
import { runTransaction } from './retry';

/**
 * The request side of a source (migration 20, DESIGN.md D14). `acceptRequest` stores a request and makes one delivery for
 * each enabled route of its source, all in one transaction, so a request is either stored and fanned out or not there at
 * all. The tick's sender delivers them; nothing here calls a destination.
 */

type Time = number | string | bigint;

const MAX_CAUSE_CHARS = 200;

function checked(input: InboundRequest): { method: string; contentType: string | null } {
  if (!(input.body instanceof Uint8Array)) {
    throw new UnsupportedOptionError('body', 'must be bytes');
  }
  if (input.body.byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new UnsupportedOptionError('body', `must be at most ${MAX_REQUEST_BODY_BYTES} bytes`);
  }
  const method = typeof input.method === 'string' ? input.method.toUpperCase() : '';
  if (!/^[A-Z]{1,16}$/u.test(method)) {
    throw new UnsupportedOptionError('method', 'must be an HTTP method');
  }
  const contentType = input.contentType === null ? '' : clipText(input.contentType);
  return { method, contentType: contentType === '' ? null : contentType };
}

/**
 * Stores an accepted request and makes its deliveries (`fanOut`: the filter, the dedupe, the shape, the delay). `unavailable`
 * when the source was removed or disabled since the ingest looked it up. Headers and the query are redacted and clipped
 * here, so no caller can forget to.
 */
export async function acceptRequest(
  ctx: StoreContext,
  sourceId: string,
  input: InboundRequest
): Promise<AcceptResult> {
  const source = identifier('sourceId', sourceId);
  const { method, contentType } = checked(input);
  return ctx.db.run('acceptRequest', (sql) =>
    runTransaction(sql, async (tx): Promise<AcceptResult> => {
      const now = await ctx.db.time.now(tx);
      // KEY SHARE: a delete of the source in flight finishes first and we see it gone; a rename or a rotation does not wait.
      const [found] = await tx<Array<{ enabled: boolean; verification_header: string | null }>>`
        SELECT enabled, verification_header FROM qcloud_sources
        WHERE namespace = ${ctx.namespace} AND id = ${source} FOR KEY SHARE`;
      if (!found || !found.enabled) return { outcome: 'unavailable' };
      const headers = clipPairs(input.headers, found.verification_header);
      const query = clipPairs(input.query);
      const [request] = await tx<Array<{ id: Time }>>`
        INSERT INTO qcloud_requests
          (namespace, source_id, received_at, method, headers, query, content_type, body, status)
        VALUES (${ctx.namespace}, ${source}, ${now}, ${method}, ${JSON.stringify(headers)}::text::jsonb,
                ${JSON.stringify(query)}::text::jsonb, ${contentType}, ${input.body}, 'accepted')
        RETURNING id`;
      const requestId = String(request!.id);
      const made = await fanOut(tx, ctx, {
        source,
        requestId,
        now,
        document: requestDocument({ method, headers, query, contentType, body: input.body }),
        dedupe: true,
      });
      return { outcome: 'accepted', id: requestId, ...made };
    })
  );
}

/**
 * Stores a request the ingest refused, with its `cause`, unless the source is over `MAX_REJECTED_PER_MINUTE` in the
 * current fixed minute: then it is only counted (`rejected_dropped`), so a flood of bad requests cannot fill the table.
 * One statement decides, from the source row's own window, so the cap holds across ingest processes. A rejected request
 * keeps no body: the cause, the headers and the query say what it was, and it cannot be replayed. `stored: false` also for
 * a source that is gone.
 */
export async function rejectRequest(
  ctx: StoreContext,
  sourceId: string,
  input: InboundRequest,
  cause: string
): Promise<RejectResult> {
  const source = identifier('sourceId', sourceId);
  const { method, contentType } = checked({ ...input, body: new Uint8Array() });
  const why = clipText(cause).slice(0, MAX_CAUSE_CHARS);
  return ctx.db.run('rejectRequest', async (sql) => {
    const now = await ctx.db.time.now(sql);
    // Every right-hand side reads the old row: a window that has ended starts again at 1; in a window, the count climbs to
    // one past the cap and stays there, and a request that arrives at the cap is the one that is dropped.
    const [slot] = await sql<Array<{ store: boolean; headerName: string | null }>>`
      UPDATE qcloud_sources
      SET reject_window_count = CASE WHEN reject_window_start + ${REJECT_WINDOW_MS} <= ${now} THEN 1
                                     ELSE least(reject_window_count + 1, ${MAX_REJECTED_PER_MINUTE + 1}) END,
          rejected_dropped = rejected_dropped
            + CASE WHEN reject_window_start + ${REJECT_WINDOW_MS} > ${now}
                    AND reject_window_count >= ${MAX_REJECTED_PER_MINUTE} THEN 1 ELSE 0 END,
          reject_window_start = CASE WHEN reject_window_start + ${REJECT_WINDOW_MS} <= ${now}
                                     THEN ${now} ELSE reject_window_start END
      WHERE namespace = ${ctx.namespace} AND id = ${source}
      RETURNING reject_window_count <= ${MAX_REJECTED_PER_MINUTE} AS store, verification_header AS "headerName"`;
    if (!slot || !slot.store) return { stored: false };
    await sql`
      INSERT INTO qcloud_requests
        (namespace, source_id, received_at, method, headers, query, content_type, status, cause)
      VALUES (${ctx.namespace}, ${source}, ${now}, ${method},
              ${JSON.stringify(clipPairs(input.headers, slot.headerName))}::text::jsonb,
              ${JSON.stringify(clipPairs(input.query))}::text::jsonb, ${contentType}, 'rejected', ${why})`;
    return { stored: true };
  });
}
