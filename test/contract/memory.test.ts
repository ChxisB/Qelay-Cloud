import { describe, expect, test } from 'bun:test';
import type { Delivery } from '@qelay-cloud/core';
import { MemoryTransport } from '@qelay-cloud/transport-local';
import { ManualClock } from '../support/clock';
import { CONTRACT_SKIPS } from './skips';
import type { TransportHarness } from './transport';
import { bell, describeTransportContract } from './transport';

const VISIBILITY_TIMEOUT_MS = 30_000;

async function yieldToEventLoop(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Bun.sleep(0);
}

function harness(options: ConstructorParameters<typeof MemoryTransport>[0] = {}) {
  const clock = new ManualClock();
  const transport = new MemoryTransport({
    clock,
    visibilityTimeoutMs: VISIBILITY_TIMEOUT_MS,
    ...options,
  });
  const h: TransportHarness & { readonly transport: MemoryTransport } = {
    transport,
    redeliveryAfterMs: VISIBILITY_TIMEOUT_MS,
    async advance(ms) {
      clock.advance(ms);
      transport.tick();
      await yieldToEventLoop();
    },
    settle: yieldToEventLoop,
    close: () => transport.close(),
  };
  return h;
}

describeTransportContract('memory', async () => harness(), { skips: CONTRACT_SKIPS.memory });

describe('MemoryTransport fault controls', () => {
  function collect(h: ReturnType<typeof harness>) {
    const seen: string[] = [];
    const sub = h.transport.subscribe(
      'q',
      async (d: Delivery) => {
        seen.push(d.bell?.jobId ?? '?');
        await d.ack();
      },
      { capacity: () => 10 }
    );
    return { seen, sub };
  }

  test('a dropped ring is reported ok and never delivered, and ringing again recovers it', async () => {
    const h = harness();
    const { seen, sub } = collect(h);
    h.transport.dropNext();
    expect(await h.transport.ring([{ bell: bell('q', 'lost') }])).toEqual([{ ok: true }]);
    await h.settle();
    expect(seen).toEqual([]);
    await h.transport.ring([{ bell: bell('q', 'lost') }]);
    await h.settle();
    expect(seen).toEqual(['lost']);
    await sub.close();
    await h.close();
  });

  test('a duplicated ring is delivered twice', async () => {
    const h = harness();
    const { seen, sub } = collect(h);
    h.transport.duplicateNext();
    await h.transport.ring([{ bell: bell('q', 'twice') }]);
    await h.settle();
    expect(seen).toEqual(['twice', 'twice']);
    await sub.close();
    await h.close();
  });

  test('a delayed ring becomes visible only after the extra lag', async () => {
    const h = harness();
    const { seen, sub } = collect(h);
    h.transport.delayNext(1_000);
    await h.transport.ring([{ bell: bell('q', 'slow') }]);
    await h.settle();
    expect(seen).toEqual([]);
    await h.advance(1_000);
    expect(seen).toEqual(['slow']);
    await sub.close();
    await h.close();
  });

  test('a half-failed batch reports each item and delivers only the accepted ones', async () => {
    const h = harness();
    const { seen, sub } = collect(h);
    h.transport.failWhere((item) => item.bell.jobId === 'b', 'rejected');
    const results = await h.transport.ring(['a', 'b', 'c'].map((id) => ({ bell: bell('q', id) })));
    expect(results).toEqual([{ ok: true }, { ok: false, reason: 'rejected' }, { ok: true }]);
    await h.settle();
    expect(seen.toSorted()).toEqual(['a', 'c']);
    await sub.close();
    await h.close();
  });

  test('the pick option reorders delivery', async () => {
    const h = harness({ pick: (deliverable) => deliverable - 1 });
    await h.transport.ring(['a', 'b', 'c'].map((id) => ({ bell: bell('q', id) })));
    const { seen, sub } = collect(h);
    await h.settle();
    expect(seen).toEqual(['c', 'b', 'a']);
    await sub.close();
    await h.close();
  });
});
