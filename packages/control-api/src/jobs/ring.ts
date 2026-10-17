import type { DeliveryTransport, Ring, RungEntry } from '@qelay-cloud/core';
import type { PostgresStore } from '@qelay-cloud/store-postgres';
import type { Logger } from '../http/log';

/**
 * Rings the bells of a committed operator action (a promote, a delay change), then records which the
 * broker took. The change is already in Postgres, so nothing here fails the caller: a bell that is
 * refused or lost is logged, its job keeps a null `rung_at`, and the tick rings it again (DESIGN.md
 * section 3). It is the same contract as the SDK's `ringAfterCommit`, which is internal to the SDK.
 */
export async function ringAfterCommit(
  store: PostgresStore,
  transport: DeliveryTransport,
  logger: Logger,
  rings: readonly Ring[]
): Promise<void> {
  if (rings.length === 0) return;
  const batch = Math.max(1, transport.capabilities.maxRingBatch);
  const rung: RungEntry[] = [];
  for (let start = 0; start < rings.length; start += batch) {
    const chunk = rings.slice(start, start + batch);
    try {
      const results = await transport.ring(
        chunk.map((ring) => ({ bell: ring.bell, deliverAfterMs: ring.dueInMs }))
      );
      chunk.forEach((ring, index) => {
        if (results[index]?.ok === true && ring.bell.jobId !== undefined) {
          rung.push({ jobId: ring.bell.jobId, deliverAfterMs: ring.dueInMs });
        }
      });
    } catch {
      logger.warn('ring failed after an operator action; the tick will ring it', {
        count: chunk.length,
      });
    }
  }
  if (rung.length === 0) return;
  try {
    await store.markRung(rung);
  } catch {
    logger.warn('could not record rung bells', { count: rung.length });
  }
}
