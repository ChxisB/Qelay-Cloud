/**
 * A worker the walkthrough can start and stop (`POST /worker/start`, `/worker/stop` of the e2e
 * control server): the SDK's own `Worker` on the runtime's store and transport, so the Workers page
 * has a registry row to show and a stopped worker leaves its queue to wait.
 *
 * The handler fails a job whose data says `fail`, with `unrecoverable` when it says so too, and
 * otherwise completes it, so one worker takes the whole walkthrough's mix of jobs.
 */
import type { MemoryTransport } from '@qelay-cloud/transport-local';
import { UnrecoverableError, Worker } from '../../sdk/src';
import type { PostgresStore } from '../../store-postgres/src';
import { E2E_WORKER_NAME } from './config';

interface JobData {
  readonly fail?: boolean;
  readonly unrecoverable?: boolean;
}

export class WorkerControl {
  #worker: Worker<JobData, unknown> | null = null;
  #bells: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: PostgresStore,
    private readonly transport: MemoryTransport
  ) {}

  get running(): boolean {
    return this.#worker !== null;
  }

  start(queue: string): void {
    if (this.#worker !== null) throw new Error('a worker is already running');
    const worker = new Worker<JobData, unknown>(
      queue,
      async (job) => {
        await job.log(`handling ${job.name}`);
        if (job.data.fail !== true) return { handled: job.name };
        if (job.data.unrecoverable === true) throw new UnrecoverableError('walkthrough failure');
        throw new Error('walkthrough failure');
      },
      {
        store: this.store,
        transport: this.transport,
        concurrency: 2,
        // Short, so the Workers page sees the row within its first poll.
        heartbeatInterval: 500,
        workerName: E2E_WORKER_NAME,
      }
    );
    worker.on('error', () => {});
    this.#worker = worker;
    // MemoryTransport has no timers: it moves a delayed bell only when it is called.
    this.#bells = setInterval(() => this.transport.tick(), 50);
  }

  async stop(): Promise<void> {
    if (this.#bells !== null) clearInterval(this.#bells);
    this.#bells = null;
    const worker = this.#worker;
    this.#worker = null;
    await worker?.close({ graceMs: 1_000, timeout: 2_000 });
  }
}
