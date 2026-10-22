import { describe, expect, test } from 'bun:test';
import { STRICT_URL_POLICY } from '@qelay-cloud/core';
import type { AttemptOutcome, PostgresStore } from '@qelay-cloud/store-postgres';
import type { ClaimedDelivery } from '@qelay-cloud/store-postgres';
import { noTelemetry } from '../src/telemetry';
import { resolveWebhookConfig } from '../src/webhookConfig';
import type { PostRequest, PostResult } from '../src/webhookHttp';
import { runWebhookLoop } from '../src/webhookLoop';
import { delivery, PUBLIC_ADDRESS } from './webhookSupport';

/** A store that hands out `queue`, with the first `claimFaults` claims and `recordFaults` records failing. */
function fakeStore(queue: ClaimedDelivery[], faults = { claim: 0, record: 0 }) {
  const recorded: AttemptOutcome[] = [];
  const writes = { count: 0 };
  const limits: number[] = [];
  const store = {
    webhooks: {
      writeDeliveries: async () => {
        writes.count += 1;
        return { active: false, events: 0, written: 0, more: false, gap: false };
      },
      async claimDue(options: { limit: number }) {
        limits.push(options.limit);
        if (faults.claim-- > 0) throw new Error('db down');
        return queue.splice(0, options.limit);
      },
      async record(outcomes: readonly AttemptOutcome[]) {
        if (faults.record-- > 0) throw new Error('db down');
        recorded.push(...outcomes);
        return {
          delivered: outcomes.filter((o) => o.ok).length,
          retrying: 0,
          failed: 0,
          stale: 0,
          paused: 0,
        };
      },
    },
  } as unknown as Pick<PostgresStore, 'webhooks' | 'enqueue'>;
  return { store, recorded, limits, writes };
}

const hook = (id: number) =>
  delivery({ deliveryId: String(id), url: `https://h${id}.example.com/in` });
const ok: PostResult = { kind: 'status', status: 200 };

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('timed out waiting');
    await Bun.sleep(5);
  }
}

function run(
  store: Pick<PostgresStore, 'webhooks' | 'enqueue'>,
  post: (request: PostRequest) => Promise<PostResult>,
  telemetry = noTelemetry
) {
  const config = resolveWebhookConfig({ concurrency: 2, idleMs: 10 }, STRICT_URL_POLICY)!;
  const stop = new AbortController();
  const done = runWebhookLoop(
    store,
    { config, post, resolve: async () => [PUBLIC_ADDRESS] },
    telemetry,
    stop.signal
  );
  return { stop: () => stop.abort(), done };
}

describe('the webhook loop', () => {
  test('a slow receiver does not hold up the deliveries behind it', async () => {
    const { store, recorded, limits } = fakeStore([1, 2, 3, 4].map(hook));
    let release: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const loop = run(store, async (request) => {
      if (request.hostHeader.startsWith('h1.')) await slow;
      return ok;
    });
    await until(() => recorded.length === 3);
    expect(recorded.map((o) => o.deliveryId).sort()).toEqual(['2', '3', '4']);
    // One slot was taken the whole time, so it never asked for more than the free one.
    expect(Math.max(...limits)).toBe(2);
    release!();
    await until(() => recorded.length === 4);
    loop.stop();
    await loop.done;
  });

  test('stopping lets the sends in flight finish and records them', async () => {
    const { store, recorded } = fakeStore([hook(1)]);
    let started = false;
    const loop = run(store, async () => {
      started = true;
      await Bun.sleep(80);
      return ok;
    });
    await until(() => started);
    loop.stop();
    await loop.done;
    expect(recorded.map((o) => [o.deliveryId, o.ok])).toEqual([['1', true]]);
  });

  test('a store error is reported and the loop carries on', async () => {
    const { store, recorded } = fakeStore([hook(1)], { claim: 1, record: 0 });
    const errors: string[] = [];
    const loop = run(store, async () => ok, {
      ...noTelemetry,
      error: (step, error) => void errors.push(`${step}: ${(error as Error).message}`),
    });
    await until(() => recorded.length === 1);
    loop.stop();
    await loop.done;
    expect(errors).toEqual(['webhooks: db down']);
  });

  test('outcomes the store did not take are recorded on the next try, not lost', async () => {
    const { store, recorded } = fakeStore([hook(1)], { claim: 0, record: 2 });
    const loop = run(store, async () => ok);
    await until(() => recorded.length === 1);
    loop.stop();
    await loop.done;
    expect(recorded.map((o) => o.deliveryId)).toEqual(['1']);
  });

  test('runs the delivery writer on its own beat, and a failing writer does not stop the sends', async () => {
    const { store, recorded, writes } = fakeStore([hook(1)]);
    (store.webhooks as unknown as { writeDeliveries: () => Promise<never> }).writeDeliveries =
      async () => {
        writes.count += 1;
        throw new Error('writer down');
      };
    const errors: string[] = [];
    const loop = run(store, async () => ok, {
      ...noTelemetry,
      error: (step) => void errors.push(step),
    });
    await until(() => recorded.length === 1 && writes.count >= 2);
    loop.stop();
    await loop.done;
    expect(errors).toContain('webhook-writer');
  });
});
