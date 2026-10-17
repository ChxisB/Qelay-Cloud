import { MemoryTransport } from '@qelay-cloud/transport-local';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import type { LoopStats } from '../src/loop';
import { TickLoop } from '../src/loop';

export interface LatenessOptions {
  /** A test store on the database clock (`clock: null`), whose own ring window is 0. */
  readonly t: TestStore;
  readonly intervalMs: number;
  /** The window the tick rings delayed jobs ahead by. 0: only once due. */
  readonly windowMs: number;
  readonly jobs: number;
  readonly queue: string;
  /** Receives one line per ring and per delivery, for finding out why a job was late. */
  readonly trace?: (line: string) => void;
}

export interface Stats {
  readonly n: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly min: number;
}

export interface LatenessResult extends Stats {
  /** Deliveries of a bell for a job that was not yet due: a ring that came early. */
  readonly earlyBells: number;
  /** Mean wall time of one tick pass, from the loop's own telemetry. */
  readonly tickMeanMs: number;
  /** Each job's lateness (ms), in the order of its `run_at`. */
  readonly lateness: readonly number[];
  readonly loop: LoopStats;
}

export function stat(values: readonly number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  return {
    n: sorted.length,
    mean: values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length),
    p50: at(50),
    p95: at(95),
    max: sorted[sorted.length - 1]!,
    min: sorted[0]!,
  };
}

/**
 * How late a delayed job is claimed after its `run_at`, with the real in-process loop (`TickLoop`)
 * as the only thing that rings it. The jobs are enqueued by a store with no ring window, so the
 * enqueue rings nothing and the tick is the one whose precision is measured. The bell goes to an
 * in-process transport that is moved every few milliseconds, so the broker adds almost nothing:
 * on a real queue, add its own delivery latency (task 03 measured tens of milliseconds).
 *
 * Both ends are database time: `run_at` is the database's, and the claim time is read from it.
 */
export async function measureLateness(o: LatenessOptions): Promise<LatenessResult> {
  const { t, intervalMs } = o;
  const databaseNow = () => t.fresh.db.run('now', (sql) => t.fresh.db.time.now(sql));
  const span = 3 * intervalMs;
  // Delays spread over three intervals by a step that does not divide the interval, so the
  // phase against the tick is spread evenly.
  await t.store.enqueue(
    Array.from({ length: o.jobs }, (_, n) => ({
      queue: o.queue,
      data: n,
      options: { delay: 400 + ((n * 977) % span) },
    }))
  );
  const rows = await t.fresh.sql<Array<{ id: string; run_at: string | number }>>`
    SELECT id, run_at FROM qcloud_jobs WHERE queue = ${o.queue}`;
  const runAt = new Map(rows.map((row) => [row.id, Number(row.run_at)]));

  const claimedAt = new Map<string, number>();
  /**
   * What a worker does with a bell (`claimForBell` in the SDK): a claim never waits for a row that
   * another transaction holds, and right after a ring that is `markRung`, so a bell delivered at
   * once can find the job it was sent for, or another, locked. An empty claim while a job of the
   * queue is still waiting is made once more after a short pause. Without it that job waits for
   * the tick's re-ring, a full interval or more, and that is not the tick's lateness.
   */
  const claimForBell = async () => {
    const store = t.another();
    const first = await store.claim(o.queue, 'lateness', 1);
    if (first.length > 0) return first;
    const waiting = await store.listJobs({
      queue: o.queue,
      states: ['waiting', 'prioritized'],
      limit: 1,
    });
    if (waiting.items.length === 0) return first;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return store.claim(o.queue, 'lateness', 1);
  };
  let earlyBells = 0;
  const trace = o.trace ?? (() => {});
  const transport = new (class extends MemoryTransport {
    override async ring(items: Parameters<MemoryTransport['ring']>[0]) {
      const at = await databaseNow();
      for (const item of items) {
        const due = runAt.get(item.bell.jobId ?? '');
        trace(
          `ring job ${item.bell.jobId?.slice(-6)} after ${item.deliverAfterMs ?? 0} due in ${due === undefined ? '?' : due - at}`
        );
      }
      return super.ring(items);
    }
  })();
  const subscription = transport.subscribe(
    o.queue,
    async (delivery) => {
      const jobId = delivery.bell?.jobId;
      const due = jobId === undefined ? undefined : runAt.get(jobId);
      const arrived = await databaseNow();
      if (due !== undefined && arrived < due) earlyBells += 1;
      const claimed = await claimForBell();
      trace(
        `deliver job ${jobId?.slice(-6)} due in ${due === undefined ? '?' : due - arrived} claimed ${claimed.map((job) => job.id.slice(-6)).join(',') || 'nothing'}`
      );
      await delivery.ack();
      for (const job of claimed) {
        claimedAt.set(job.id, await databaseNow());
        await t.store.complete(job.lease, 'ok');
      }
    },
    { capacity: () => 8 }
  );
  const mover = setInterval(() => transport.tick(), 5);

  const durations: number[] = [];
  const loop = new TickLoop(
    {
      store: t.another({ ringWindowMs: o.windowMs }),
      transport,
      telemetry: {
        duration: (step, ms) => {
          if (step === 'pass') durations.push(ms);
        },
        gauge() {},
        error: (step, error) => {
          throw new Error(`the tick reported an error in ${step}: ${String(error)}`);
        },
      },
    },
    { intervalMs, ringGraceMs: 0, ringWindowMs: o.windowMs }
  );
  try {
    loop.start();
    const deadline = Date.now() + span + 6 * intervalMs + 5_000;
    while (claimedAt.size < runAt.size) {
      if (Date.now() > deadline) {
        throw new Error(`only ${claimedAt.size} of ${runAt.size} jobs were claimed in time`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    clearInterval(mover);
    await loop.stop();
    await subscription.close();
    await transport.close();
  }
  const late = [...runAt].map(([id, due]) => claimedAt.get(id)! - due);
  return {
    ...stat(late),
    earlyBells,
    tickMeanMs: durations.reduce((sum, ms) => sum + ms, 0) / Math.max(1, durations.length),
    lateness: late,
    loop: loop.stats,
  };
}
