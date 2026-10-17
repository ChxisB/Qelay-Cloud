/**
 * The whole example in one process, with the checks that make it a test: migrate, register the recurring
 * report, start a worker with its tick, produce, wait for every job to finish, and verify what ran.
 *
 *   docker compose -f examples/orders/docker-compose.yml up -d --wait
 *   bun run examples/orders/src/demo.ts
 *
 * Exits 1 when anything differs from what the example promises. Times are short so it ends in seconds.
 */
import type { JobCounts } from '../../../packages/sdk/src';
import { Queue } from '../../../packages/sdk/src';
import { migrate } from '../../../packages/store-postgres/src';
import type { Ledger } from './jobs';
import { JOBS, QUEUE } from './jobs';
import { produce } from './producer';
import type { OrdersEnv } from './runtime';
import { openRuntime, ordersEnv } from './runtime';
import { registerReport } from './schedule';
import { startWorker } from './worker';

export interface DemoReport {
  readonly ran: Readonly<Record<string, number>>;
  readonly counts: Readonly<JobCounts>;
  readonly deadLettered: readonly { readonly reason: string; readonly attempts: number }[];
  readonly reminderLateByMs: number;
}

const ORDERS = 5;
const REPORTS = 3;
const REMINDER_IN_MS = 1_500;

export async function runDemo(env: OrdersEnv): Promise<DemoReport> {
  const runtime = openRuntime(env);
  const ledger: Ledger = new Map();
  let queue: Queue | undefined;
  let running: ReturnType<typeof startWorker> | undefined;
  try {
    await migrate(runtime.db);
    queue = new Queue(QUEUE, { store: runtime.store, transport: runtime.transport });
    await registerReport(runtime.store, { everyMs: 500, times: REPORTS });
    running = startWorker(runtime, ledger, { tickEveryMs: 200 });
    const produced = await produce(runtime, { orders: ORDERS, reminderInMs: REMINDER_IN_MS });

    // Done: every order, the reminder and the reports completed, and the charge is in the dead-letter queue.
    const deadline = Date.now() + 30_000;
    let counts = await queue.getJobCounts();
    const finished = (c: JobCounts) =>
      c.completed === ORDERS + 1 + REPORTS &&
      c.failed === 1 &&
      !c.waiting &&
      !c.active &&
      !c.delayed;
    while (!finished(counts) && Date.now() < deadline) {
      await Bun.sleep(100);
      counts = await queue.getJobCounts();
    }
    const reminder = await queue.getJob(produced.reminder);
    const report: DemoReport = {
      ran: Object.fromEntries(ledger),
      counts,
      deadLettered: (await queue.getDlq()).map((e) => ({ reason: e.reason, attempts: e.attempts })),
      reminderLateByMs: (reminder?.processedOn ?? 0) - (reminder?.timestamp ?? 0) - REMINDER_IN_MS,
    };
    expectDemo(
      finished(counts),
      `jobs did not finish: ${JSON.stringify(counts)} (the demo counts every job in the namespace: start from an empty database)`
    );
    expectDemo(ledger.get(JOBS.placed) === ORDERS, `orders ran ${ledger.get(JOBS.placed)} times`);
    expectDemo(ledger.get(JOBS.reminder) === 1, `reminder ran ${ledger.get(JOBS.reminder)} times`);
    expectDemo(ledger.get(JOBS.report) === REPORTS, `report ran ${ledger.get(JOBS.report)} times`);
    expectDemo(ledger.get(JOBS.charge) === 3, `charge was tried ${ledger.get(JOBS.charge)} times`);
    expectDemo(
      report.deadLettered.length === 1 &&
        report.deadLettered[0]!.reason === 'max_attempts_exceeded',
      `dead-letter queue: ${JSON.stringify(report.deadLettered)}`
    );
    return report;
  } finally {
    await running?.stop();
    await queue?.close();
    await runtime.close();
  }
}

function expectDemo(ok: boolean, message: string): void {
  if (!ok) throw new Error(`the example did not do what it promises: ${message}`);
}

if (import.meta.main) {
  const report = await runDemo(ordersEnv());
  console.log(JSON.stringify(report, null, 2));
}
