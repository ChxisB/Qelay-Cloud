import { flattenFlow, type StepRecord } from '@qelay-cloud/core';
import type { openTestStore } from '../../store-postgres/test/storeHelpers';

type Store = Awaited<ReturnType<typeof openTestStore>>['store'];

/** One job in `queue`, claimed and failed for good; null when nothing could be claimed. */
export async function seedFailedJob(
  store: Store,
  queue: string,
  name: string
): Promise<{ id: string } | null> {
  const [job] = await store.enqueue([{ queue, name, data: { seeded: true }, options: {} }]);
  const [claimed] = await store.claim(queue, 'e2e-seed', 1);
  if (!job || !claimed) return null;
  await store.fail(claimed.lease, { message: 'seeded failure', unrecoverable: true });
  return { id: job.id };
}

/**
 * A parent and two children in one queue (so one worker can finish the whole flow). One child completes
 * and the other fails for good, with no policy: it holds the parent in waiting-children. Null when the
 * children could not be claimed.
 */
export async function seedStuckFlow(
  store: Store,
  queue: string,
  name: string
): Promise<{ root: string | undefined; failed: string; fine: string } | null> {
  const added = await store.flows.add(
    flattenFlow({
      queue,
      name,
      data: { seeded: true },
      children: [
        { queue, name: 'fine-child', data: { seeded: true } },
        { queue, name: 'doomed-child', data: { seeded: true } },
      ],
    })
  );
  const claimed = await store.claim(queue, 'e2e-seed', 2);
  const doomed = claimed.find((job) => job.name === 'doomed-child');
  const fine = claimed.find((job) => job.name === 'fine-child');
  if (!doomed || !fine) return null;
  await store.complete(fine.lease, 'done');
  await store.fail(doomed.lease, { message: 'seeded failure', unrecoverable: true });
  return {
    root: added.created ? added.jobs[0]?.id : added.root.id,
    failed: doomed.id,
    fine: fine.id,
  };
}

/** A run of `iterations` items in one for-each, saved as an engine leaves it: 1% failed, the rest done or still to run. */
export async function seedFanOutRun(
  store: Store,
  id: string,
  iterations: number
): Promise<{ id: string }> {
  const now = Date.now();
  const steps: Record<string, StepRecord> = {
    prepare: {
      status: 'completed',
      startedAt: now - 60_000,
      completedAt: now - 59_000,
      attempts: 1,
    },
    notify: { status: 'running', startedAt: now - 58_000 },
  };
  for (let n = 0; n < iterations; n++) {
    const failed = n % 100 === 7;
    steps[`notify:${n}`] = {
      status: failed ? 'failed' : n < iterations * 0.9 ? 'completed' : 'pending',
      loopIndex: n,
      loopItem: { sku: `sku-${n}` },
      startedAt: now - 57_000 + n,
      ...(failed ? { error: `no stock for sku-${n}` } : {}),
    };
  }
  await store.workflows.save({
    id,
    workflowName: 'e2e-fulfilment',
    input: { warehouse: 'north', items: iterations },
    steps,
    currentNodeIndex: 1,
    state: 'running',
    signals: {},
    createdAt: now - 60_000,
    updatedAt: now,
  });
  return { id };
}
