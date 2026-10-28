/**
 * A `Worker` in its own process, for the crash tests. It prints `READY`, then `STARTED <jobId>
 * <attemptsMade>` for each job it starts, and never finishes one: the test kills it (SIGKILL) or
 * asks it to stop (SIGTERM, which closes the worker with a short grace and prints `CLOSED`).
 * It rings its own bell, since a `MemoryTransport` is private to a process.
 *
 * Arguments: database url, schema, namespace, queue, lock duration (ms), grace (ms), and optionally a batch size, which
 * makes it a batch worker that prints `BATCH <jobId>,<jobId>...` for each batch it starts.
 */
import { MemoryTransport } from '@qelay-cloud/transport-local';
import { Worker } from '../src';

const [url, schema, namespace, queue, lockDuration, grace, batchSize] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string | undefined,
];

const transport = new MemoryTransport();
const hang = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
  });
const options = {
  databaseUrl: url,
  database: { schema, poolSize: 3 },
  namespace,
  transport,
  lockDuration: Number(lockDuration),
  heartbeatInterval: 0,
};
const worker =
  batchSize === undefined
    ? new Worker(
        queue,
        (job, { signal }) => {
          console.log(`STARTED ${job.id} ${job.attemptsMade}`);
          return hang(signal);
        },
        options
      )
    : new Worker(
        queue,
        (jobs, { signal }) => {
          console.log(`BATCH ${jobs.map((job) => job.id).join(',')}`);
          return hang(signal);
        },
        { ...options, batch: { size: Number(batchSize), maxWaitMs: 200 } }
      );
worker.on('error', (error) => console.log(`ERROR ${error.message}`));

process.on('SIGTERM', () => {
  void worker.close({ graceMs: Number(grace), timeout: 2000 }).then(() => {
    console.log('CLOSED');
    process.exit(0);
  });
});

await worker.waitUntilReady();
await transport.ring([{ bell: { namespace, queue } }]);
console.log('READY');
