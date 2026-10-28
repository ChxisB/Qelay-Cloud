import type { StoreContext } from './context';

/** Deletes up to `limit` stored requests (D14) received over `keepMs` ago, oldest first. Returns how many went. */
export async function pruneRequests(
  ctx: StoreContext,
  limit: number,
  keepMs: number
): Promise<number> {
  return ctx.db.run('pruneRequests', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const rows = await sql<Array<{ id: number | string }>>`
      DELETE FROM qcloud_requests
      WHERE (namespace, id) IN (
        SELECT namespace, id FROM qcloud_requests
        WHERE namespace = ${ctx.namespace} AND received_at < ${now - keepMs}
        ORDER BY received_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
      RETURNING id`;
    return rows.length;
  });
}
