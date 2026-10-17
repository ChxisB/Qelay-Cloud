import type { Ring, RingItem, RingResult, RungEntry } from '@qelay-cloud/core';
import type { Runtime } from './runtime';

/**
 * Rings the bells of a committed mutation, then tells the store which ones the broker took
 * (task 06 gate, DESIGN.md section 3). The job is already in Postgres, so nothing here may fail the
 * caller: a ring that is refused, lost or thrown is logged and counted, its job keeps a null
 * `rung_at`, and the tick rings it again. A delay past the transport's window is no error either:
 * the tick rings that job nearer its time.
 */
export async function ringAfterCommit(rt: Runtime, rings: readonly Ring[]): Promise<void> {
  if (rings.length === 0) return;
  const batch = Math.max(1, rt.transport.capabilities.maxRingBatch);
  const rung: RungEntry[] = [];
  for (let start = 0; start < rings.length; start += batch) {
    const chunk = rings.slice(start, start + batch);
    const results = await ringChunk(rt, chunk);
    // A call that threw is already logged and counted for the whole chunk; its jobs stay unrung.
    if (results === null) continue;
    chunk.forEach((ring, index) => {
      const result = results[index];
      if (result?.ok === true) {
        if (ring.bell.jobId !== undefined) {
          rung.push({ jobId: ring.bell.jobId, deliverAfterMs: ring.dueInMs });
        }
        return;
      }
      noteRefusal(rt, ring, result === undefined ? 'unreachable' : result.reason);
    });
  }
  if (rung.length === 0) return;
  try {
    await rt.store.markRung(rung);
    rt.count('qcloud.ring.rung', rung.length);
  } catch (error) {
    // The bells are out; only the record that they are is missing. The tick rings these jobs again, harmlessly.
    rt.warn('could not record rung bells', { count: rung.length, error: describe(error) });
    rt.count('qcloud.ring.mark_failed', rung.length);
  }
}

async function ringChunk(rt: Runtime, chunk: readonly Ring[]): Promise<RingResult[] | null> {
  const items: RingItem[] = chunk.map((ring) => ({
    bell: ring.bell,
    deliverAfterMs: ring.dueInMs,
  }));
  try {
    return await rt.transport.ring(items);
  } catch (error) {
    rt.warn('ring failed', { count: chunk.length, error: describe(error) });
    rt.count('qcloud.ring.failed', chunk.length, { reason: 'unreachable' });
    return null;
  }
}

function noteRefusal(rt: Runtime, ring: Ring, reason: string): void {
  if (reason === 'delay-too-long') {
    rt.count('qcloud.ring.deferred', 1);
    return;
  }
  rt.count('qcloud.ring.failed', 1, { reason });
  rt.warn('bell not rung', { queue: ring.bell.queue, jobId: ring.bell.jobId, reason });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
