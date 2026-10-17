/** The producer: what an API handler would do. Adds orders, one reminder an hour out and one order that cannot be charged. */
import { Queue } from '../../../packages/sdk/src';
import { CHARGE_OPTIONS, JOBS, QUEUE } from './jobs';
import type { Order } from './jobs';
import type { Runtime } from './runtime';
import { openRuntime, ordersEnv } from './runtime';

export interface Produced {
  readonly orders: readonly string[];
  readonly reminder: string;
  readonly charge: string;
}

export async function produce(
  runtime: Runtime,
  options: { readonly orders?: number; readonly reminderInMs?: number } = {}
): Promise<Produced> {
  const queue = new Queue<Order>(QUEUE, { store: runtime.store, transport: runtime.transport });
  try {
    const count = options.orders ?? 5;
    // One call, one transaction, one round trip: the way to add many.
    const orders = await queue.addBulk(
      Array.from({ length: count }, (_, n) => ({
        name: JOBS.placed,
        data: { orderId: n + 1, cents: 1_000 + n },
      }))
    );
    const reminder = await queue.add(
      JOBS.reminder,
      { orderId: 1, cents: 1_000 },
      { delay: options.reminderInMs ?? 3_600_000 }
    );
    const charge = await queue.add(JOBS.charge, { orderId: 99, cents: 9_900 }, CHARGE_OPTIONS);
    return { orders: orders.map((job) => job.id), reminder: reminder.id, charge: charge.id };
  } finally {
    await queue.close();
  }
}

if (import.meta.main) {
  const runtime = openRuntime(ordersEnv());
  try {
    const produced = await produce(runtime, { orders: Number(process.argv[2] ?? 5) });
    console.log(
      `added ${produced.orders.length} orders, reminder ${produced.reminder}, charge ${produced.charge}`
    );
  } finally {
    await runtime.close();
  }
}
