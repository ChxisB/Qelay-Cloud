/** What the order of a claim needs of a due row. `size`: bytes of body, counted for a batch route only (0 elsewhere). */
interface Due {
  readonly id: number | string | bigint;
  readonly webhook_id: string;
  readonly next_attempt_at: number | string | bigint;
  readonly size: number | string;
}

/**
 * The claimed rows, at most `limit` requests' worth: the oldest of each webhook first, then the second oldest of
 * each, and so on, so a webhook with a backlog does not take every slot from one with a single
 * delivery waiting. Within a round, oldest first. A batch route (`batches`: its byte limit) is one request: its rows are
 * cut where `maxBytes` of body would be passed (the oldest always stays) and share one place in the order.
 */
export function roundRobin<Row extends Due>(
  found: readonly Row[],
  limit: number,
  batches: ReadonlyMap<string, number>
): Row[] {
  const byAge = [...found].sort(
    (a, b) => Number(a.next_attempt_at) - Number(b.next_attempt_at) || Number(a.id) - Number(b.id)
  );
  const bytes = new Map<string, number>();
  const closed = new Set<string>();
  const seen = new Map<string, number>();
  const ranked: Array<{ row: Row; rank: number }> = [];
  for (const row of byAge) {
    const maxBytes = batches.get(row.webhook_id);
    if (maxBytes === undefined) {
      const rank = seen.get(row.webhook_id) ?? 0;
      seen.set(row.webhook_id, rank + 1);
      ranked.push({ row, rank });
      continue;
    }
    if (closed.has(row.webhook_id)) continue;
    const total = bytes.get(row.webhook_id);
    const size = Number(row.size);
    if (total !== undefined && total + size > maxBytes) {
      closed.add(row.webhook_id);
      continue;
    }
    bytes.set(row.webhook_id, (total ?? 0) + size);
    ranked.push({ row, rank: 0 });
  }
  // `sort` is stable, so within a rank the age order above stands.
  ranked.sort((a, b) => a.rank - b.rank);
  const requests = new Set<string>();
  const taken: Row[] = [];
  for (const { row } of ranked) {
    const request = batches.has(row.webhook_id) ? row.webhook_id : String(row.id);
    if (!requests.has(request)) {
      if (requests.size >= limit) continue;
      requests.add(request);
    }
    taken.push(row);
  }
  return taken;
}
