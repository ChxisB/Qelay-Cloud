import type { TransactionSQL } from 'bun';
import type { StoreContext } from './context';
import type { Candidate, Planned } from './webhookPlan';

type Time = number | string | bigint;

const id = (webhook: string, key: string): string => `${webhook}\u0000${key}`;

/** The row without its window fields. */
const bare = ({ k: _k, u: _u, ...row }: Candidate): Planned => row;

/**
 * Applies each webhook's `dedupe` to a page's plan: of the events that share a key, the first in order goes and
 * the others that start inside its window (`until` of the key, kept in `qcloud_webhook_dedupe`) do not. A
 * delivery that goes opens a new window from its event's time. The windows are read, applied and written in
 * the page's transaction, so a pass that fails or repeats leaves them as they were. It is exact because one
 * writer works at a time (the cursor row lock, see `webhookWriter.ts`). A filtered-out event never gets here.
 */
export async function dedupe(
  tx: TransactionSQL,
  ctx: StoreContext,
  candidates: readonly Candidate[]
): Promise<Planned[]> {
  const keyed = candidates.filter((row) => row.k !== null);
  if (keyed.length === 0) return candidates.map(bare);
  const pairs = JSON.stringify(keyed.map((row) => ({ w: row.w, k: row.k })));
  const stored = await tx<Array<{ webhook_id: string; key: string; until: Time }>>`
    SELECT d.webhook_id, d.key, d.until FROM qcloud_webhook_dedupe d
    JOIN jsonb_to_recordset(${pairs}::text::jsonb) AS p(w text, k text)
      ON d.webhook_id = p.w AND d.key = p.k
    WHERE d.namespace = ${ctx.namespace}`;
  const until = new Map(stored.map((row) => [id(row.webhook_id, row.key), Number(row.until)]));
  const opened = new Map<string, { w: string; k: string; u: number }>();
  const kept: Planned[] = [];
  for (const row of candidates) {
    if (row.k !== null) {
      const at = id(row.w, row.k);
      if (row.t < (until.get(at) ?? 0)) continue;
      until.set(at, row.u);
      opened.set(at, { w: row.w, k: row.k, u: row.u });
    }
    kept.push(bare(row));
  }
  if (opened.size > 0) await save(tx, ctx, [...opened.values()]);
  return kept;
}

async function save(
  tx: TransactionSQL,
  ctx: StoreContext,
  windows: ReadonlyArray<{ w: string; k: string; u: number }>
): Promise<void> {
  await tx`
    INSERT INTO qcloud_webhook_dedupe (namespace, webhook_id, key, until)
    SELECT ${ctx.namespace}, r.w, r.k, r.u
    FROM jsonb_to_recordset(${JSON.stringify(windows)}::text::jsonb) AS r(w text, k text, u bigint)
    ON CONFLICT (namespace, webhook_id, key) DO UPDATE SET until = EXCLUDED.until`;
}
