import type {
  DeliveryTransport,
  Ring,
  RingItem,
  RingResult,
  RungEntry,
  StateStore,
} from '@qelay-cloud/core';
import type { Telemetry } from './telemetry';

/** What one ring step did with the rings the store asked for. */
export interface RingStepReport {
  /** Rings the store asked for. */
  readonly due: number;
  /** Taken by the broker and recorded with `markRung`. */
  readonly rung: number;
  /**
   * Refused as `delay-too-long`: the window was wider than the transport takes. Left unrung, so the
   * next tick finds them again; a count above 0 means the configuration is wrong.
   */
  readonly deferred: number;
  /** Refused by the broker (`rejected`). Left unrung. */
  readonly rejected: number;
  /** The broker could not be reached, or threw. Left unrung. */
  readonly unreachable: number;
  /** Taken by the broker but not recorded, because `markRung` failed. The next tick rings them again. */
  readonly unmarked: number;
  /** Not attempted: the broker was unreachable, or `markRung` failed, earlier in the step. */
  readonly skipped: number;
}

export interface RingDeps {
  readonly store: Pick<StateStore, 'markRung'>;
  readonly transport: Pick<DeliveryTransport, 'ring' | 'capabilities'>;
  readonly telemetry: Telemetry;
}

function batchSize(transport: Pick<DeliveryTransport, 'capabilities'>, total: number): number {
  const max = transport.capabilities.maxRingBatch;
  return Number.isFinite(max) && max >= 1 ? Math.floor(max) : Math.max(1, total);
}

/**
 * Rings what the store found, in batches of the transport's size, and reports to `markRung` the
 * bells the broker took. The delay is relative (`dueInMs` rounded up, so a bell is never early), and
 * `markRung` hears only of items whose result was `ok`, so a half-failed batch leaves exactly the
 * failed bells unrung. An unreachable broker ends the step: the rest would only wait out the same
 * retries, and the next tick finds them. Never throws.
 */
export async function ringDue(deps: RingDeps, rings: readonly Ring[]): Promise<RingStepReport> {
  const { store, transport, telemetry } = deps;
  const size = batchSize(transport, rings.length);
  const tally = { rung: 0, deferred: 0, rejected: 0, unreachable: 0, unmarked: 0 };
  let attempted = 0;

  for (let from = 0; from < rings.length; from += size) {
    const chunk = rings.slice(from, from + size);
    attempted += chunk.length;
    const items: RingItem[] = chunk.map((ring) => ({
      bell: ring.bell,
      deliverAfterMs: Math.ceil(ring.dueInMs),
    }));
    const rangAt = performance.now();
    let results: readonly RingResult[];
    try {
      results = await transport.ring(items);
    } catch (error) {
      telemetry.error('ring', error);
      results = [];
    }
    telemetry.duration('ring', Math.round(performance.now() - rangAt));

    const taken: RungEntry[] = [];
    let unreachable = 0;
    items.forEach((item, n) => {
      // A transport that returns too few results is treated as unreachable for the rest.
      const result: RingResult = results[n] ?? { ok: false, reason: 'unreachable' };
      if (result.ok) {
        tally.rung += 1;
        if (item.bell.jobId !== undefined) {
          taken.push({ jobId: item.bell.jobId, deliverAfterMs: item.deliverAfterMs ?? 0 });
        }
      } else if (result.reason === 'delay-too-long') tally.deferred += 1;
      else if (result.reason === 'rejected') tally.rejected += 1;
      else unreachable += 1;
    });
    tally.unreachable += unreachable;

    let markFailed = false;
    if (taken.length > 0) {
      const markedAt = performance.now();
      try {
        await store.markRung(taken);
      } catch (error) {
        markFailed = true;
        telemetry.error('mark', error);
        tally.unmarked += taken.length;
        tally.rung -= taken.length;
      }
      telemetry.duration('mark', Math.round(performance.now() - markedAt));
    }
    if (unreachable > 0 || markFailed) break;
  }
  return { due: rings.length, ...tally, skipped: rings.length - attempted };
}
