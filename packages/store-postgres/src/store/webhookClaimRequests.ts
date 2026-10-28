import type { TransactionSQL } from 'bun';

/**
 * The stored requests a claim's deliveries carry (D14), by id. A request the retention already removed is absent from the
 * map, and the sender refuses that delivery in words instead of sending nothing.
 */
export async function readRequests(
  tx: TransactionSQL,
  namespace: string,
  ids: ReadonlyArray<number | string | bigint>
): Promise<Map<string, { contentType: string | null; body: Uint8Array }>> {
  if (ids.length === 0) return new Map();
  const rows = await tx<
    Array<{ id: number | string | bigint; content_type: string | null; body: Uint8Array | null }>
  >`
    SELECT id, content_type, body FROM qcloud_requests
    WHERE namespace = ${namespace} AND id = ANY(${tx.array(ids.map(Number), 'BIGINT')})`;
  return new Map(
    rows.map((row) => [
      String(row.id),
      { contentType: row.content_type, body: row.body ?? new Uint8Array() },
    ])
  );
}
