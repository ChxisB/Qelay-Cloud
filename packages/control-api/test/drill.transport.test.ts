import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { RingItem, RingResult, TransportStats } from '@qelay-cloud/core';
import { MemoryTransport } from '@qelay-cloud/transport-local';
import { describeDb } from '../../../test/support/db';
import { resolveTickConfig, runTick } from '../../maintenance/src';
import type { JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';
import { bodyOf, DEV_TOKEN, harness } from './support';

/** A transport whose broker can be taken away and given back, as an expired credential does. */
class Broker extends MemoryTransport {
  down = false;

  override async ring(items: readonly RingItem[]): Promise<RingResult[]> {
    if (this.down) throw new Error('broker unreachable: credentials expired');
    return super.ring(items);
  }

  override async stats(queue: string): Promise<TransportStats> {
    if (this.down) throw new Error('broker unreachable: credentials expired');
    return super.stats(queue);
  }
}

/**
 * The transport failure drill of the Phase 2 gate (task 37): the broker's credentials break, the
 * panel's Transport page goes unknown and not blank, enqueues still succeed (the job is committed
 * and waits for a bell), and once the credentials are repaired the tick rings what was left.
 */
describeDb('drill: the transport credentials break and are repaired', () => {
  let f: JobsFixture;
  beforeAll(async () => {
    f = await openJobsFixture();
  });
  afterAll(() => f.drop());
  beforeEach(() => f.reset());

  test('enqueues succeed, the Transport page says unknown, and the tick recovers after the repair', async () => {
    const broker = new Broker({ clock: f.t.clock });
    const api = harness(
      {
        devToken: { token: DEV_TOKEN, role: 'operator' },
        rateLimit: false,
        deployment: { cacheMs: 0 },
      },
      {
        transport: { name: 'gcp-pubsub', capabilities: broker.capabilities },
        jobs: { store: f.store, transport: broker, options: { summaryCacheMs: 0 } },
      },
      f.t.clock
    );
    const transportPage = async () => {
      const response = await api.call('GET', '/transport');
      return { status: response.status, body: (await bodyOf(response)) as Record<string, any> };
    };

    broker.down = true;
    const added: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      const response = await api.call('POST', '/queues/orders/jobs', {
        body: { name: 'order', data: { n } },
      });
      expect(response.status).toBe(200);
      added.push(String(((await bodyOf(response)) as { id: unknown }).id));
    }
    // Committed, claimable, and not rung: the store is the truth, the bell is a convenience.
    const job = await api.call('GET', `/jobs/${added[0]}`);
    expect(((await bodyOf(job)) as any).job.state).toBe('waiting');

    // A bell is overdue once the tick's interval has passed without one.
    f.t.clock.advance(5_000);
    const broken = await transportPage();
    expect(broken.status).toBe(200);
    expect(broken.body.queues[0]).toMatchObject({
      queue: 'orders',
      doorbellDepth: null,
      freshness: { source: 'unavailable' },
      store: { claimable: 3, notRung: 3 },
    });
    // Nothing the page says carries what the broker's error said.
    expect(JSON.stringify(broken.body)).not.toContain('credentials expired');

    // The tick tries, fails, and says so: the status the Dashboard strip reads.
    const config = resolveTickConfig(broker, {}, f.store);
    const failed = await runTick({ store: f.store, transport: broker }, config);
    expect(failed.ring).toMatchObject({ unreachable: 3, rung: 0 });

    // The repair: the next pass rings every bell that was left, and the page reads true again.
    broker.down = false;
    f.t.clock.advance(5_000);
    const repaired = await runTick({ store: f.store, transport: broker }, config);
    expect(repaired.ring).toMatchObject({ due: 3, rung: 3, unreachable: 0 });
    const healthy = await transportPage();
    expect(healthy.body.queues[0]).toMatchObject({
      queue: 'orders',
      store: { claimable: 3, notRung: 0 },
    });
    expect(healthy.body.queues[0].doorbellDepth).not.toBeNull();
  });
});
