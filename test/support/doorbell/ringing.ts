import type { DeliveryTransport, Ring, StateStore } from '@qelay-cloud/core';

/** Anything that can ring a batch: a transport, or a stand-in that fails or rings twice. */
export type Ringer = Pick<DeliveryTransport, 'ring'>;

/**
 * What every caller of the store does with the rings it returns (DESIGN.md, "Doorbell"): ring them,
 * then tell the store which ones the broker took. A bell the broker did not take is not reported,
 * so its job stays unrung and the tick finds it. Returns how many bells were taken.
 */
export async function ringAndMark(
  store: Pick<StateStore, 'markRung'>,
  ringer: Ringer,
  rings: readonly Ring[]
): Promise<number> {
  if (rings.length === 0) return 0;
  const results = await ringer.ring(
    rings.map((ring) => ({ bell: ring.bell, deliverAfterMs: ring.dueInMs }))
  );
  const taken = rings.filter((_, index) => results[index]?.ok === true);
  const reported = taken.flatMap((ring) =>
    ring.bell.jobId === undefined ? [] : [{ jobId: ring.bell.jobId, deliverAfterMs: ring.dueInMs }]
  );
  await store.markRung(reported);
  return taken.length;
}
