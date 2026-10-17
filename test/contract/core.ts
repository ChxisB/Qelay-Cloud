import { expect } from 'bun:test';
import type { Delivery } from '@qelay-cloud/core';
import type { ContractContext } from './context';
import { bell, gate } from './context';
import type { Gate } from './context';

/**
 * What every transport does with a bell, whatever the broker: delivery, redelivery, routing, bounds and
 * stats. Nothing here depends on a capability; `capability.ts` has the tests that do.
 */
export function coreContract({ it, using }: ContractContext): void {
  it('declares capabilities a worker can plan with', async () => {
    await using(async ({ transport }) => {
      const c = transport.capabilities;
      expect(c.maxDeliverDelayMs).toBeGreaterThanOrEqual(0);
      expect(c.maxRingBatch).toBeGreaterThanOrEqual(1);
      expect(c.retryGranularityMs).toBeGreaterThanOrEqual(1);
      expect(['approximate', 'none']).toContain(c.attemptCount);
    });
  });

  it('returns one result per ring item, in order', async () => {
    await using(async ({ transport }) => {
      const items = ['a', 'b', 'c'].map((id) => ({ bell: bell('q', id) }));
      const results = await transport.ring(items);
      expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    });
  });

  it('delivers a rung bell once and does not redeliver it after ack', async () => {
    await using(async ({ transport, settle, advance, redeliveryAfterMs }) => {
      const seen: Delivery[] = [];
      const sub = transport.subscribe(
        'q',
        async (d) => {
          seen.push(d);
          await d.ack();
        },
        { capacity: () => 5 }
      );
      await transport.ring([{ bell: bell('q', 'job-1') }]);
      await settle();
      expect(seen.map((d) => d.bell)).toEqual([bell('q', 'job-1')]);
      await advance(redeliveryAfterMs + 50);
      await settle();
      expect(seen).toHaveLength(1);
      await sub.close();
    });
  });

  it('redelivers after nack', async () => {
    await using(async ({ transport, settle }) => {
      let calls = 0;
      const sub = transport.subscribe(
        'q',
        async (d) => {
          calls += 1;
          if (calls === 1) await d.nack(0);
          else await d.ack();
        },
        { capacity: () => 5 }
      );
      await transport.ring([{ bell: bell('q', 'job-1') }]);
      await settle();
      await settle();
      expect(calls).toBe(2);
      await sub.close();
    });
  });

  it('redelivers a bell that was neither acked nor nacked', async () => {
    await using(async ({ transport, settle, advance, redeliveryAfterMs }) => {
      let calls = 0;
      const sub = transport.subscribe(
        'q',
        async (d) => {
          calls += 1;
          if (calls > 1) await d.ack();
        },
        { capacity: () => 5 }
      );
      await transport.ring([{ bell: bell('q', 'job-1') }]);
      await settle();
      await advance(redeliveryAfterMs);
      await settle();
      expect(calls).toBeGreaterThanOrEqual(2);
      await sub.close();
    });
  });

  it('routes a bell only to subscribers of its queue', async () => {
    await using(async ({ transport, settle }) => {
      const seen: Delivery[] = [];
      const sub = transport.subscribe(
        'q1',
        async (d) => {
          seen.push(d);
          await d.ack();
        },
        { capacity: () => 5 }
      );
      await transport.ring([{ bell: bell('q2', 'elsewhere') }]);
      await settle();
      expect(seen).toHaveLength(0);
      await transport.ring([{ bell: bell('q1', 'here') }]);
      await settle();
      expect(seen.map((d) => d.bell?.jobId)).toEqual(['here']);
      await sub.close();
    });
  });

  it('never runs more handlers than the subscriber has capacity for', async () => {
    await using(async ({ transport, settle }) => {
      let running = 0;
      let peak = 0;
      let delivered = 0;
      const gates: Gate[] = [];
      const sub = transport.subscribe(
        'q',
        async (d) => {
          running += 1;
          peak = Math.max(peak, running);
          const g = gate();
          gates.push(g);
          await g.open;
          running -= 1;
          delivered += 1;
          await d.ack();
        },
        { capacity: () => 1 - running }
      );
      await transport.ring(['a', 'b', 'c'].map((id) => ({ bell: bell('q', id) })));
      await settle();
      expect(running).toBe(1);
      for (let i = 0; i < 3; i += 1) {
        gates[i]?.release();
        sub.refresh();
        await settle();
      }
      expect(delivered).toBe(3);
      expect(peak).toBe(1);
      await sub.close();
    });
  });

  it('tolerates the same bell rung twice and acked twice', async () => {
    await using(async ({ transport, settle }) => {
      const seen: Delivery[] = [];
      const sub = transport.subscribe(
        'q',
        async (d) => {
          seen.push(d);
          await d.ack();
          await d.ack();
        },
        { capacity: () => 5 }
      );
      await transport.ring([{ bell: bell('q', 'dup') }, { bell: bell('q', 'dup') }]);
      await settle();
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen.length).toBeLessThanOrEqual(2);
      await sub.close();
    });
  });

  it('reports stats with their freshness and never turns unknown into zero', async () => {
    await using(async ({ transport, backlog }) => {
      if (backlog) await backlog('q', 2);
      else await transport.ring([{ bell: bell('q', 'a') }, { bell: bell('q', 'b') }]);
      const stats = await transport.stats('q');
      expect(stats.source.length).toBeGreaterThan(0);
      expect(stats.observedAt).toBeGreaterThan(0);
      expect(stats.maxStalenessMs).toBeGreaterThanOrEqual(0);
      for (const value of [stats.depth, stats.inFlight, stats.delayed, stats.deadLetterDepth]) {
        if (value !== null) expect(value).toBeGreaterThanOrEqual(0);
      }
      if (stats.maxStalenessMs === 0 && stats.depth !== null) expect(stats.depth).toBe(2);
    });
  });

  it('stops delivering once the subscription is closed', async () => {
    await using(async ({ transport, settle }) => {
      const seen: Delivery[] = [];
      const sub = transport.subscribe(
        'q',
        async (d) => {
          seen.push(d);
          await d.ack();
        },
        { capacity: () => 5 }
      );
      await sub.close();
      await transport.ring([{ bell: bell('q', 'late') }]);
      await settle();
      expect(seen).toHaveLength(0);
    });
  });
}
