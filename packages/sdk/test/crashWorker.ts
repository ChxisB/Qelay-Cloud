/**
 * A `Worker` in its own process, for the crash tests. It prints `READY`, then `STARTED <jobId>
 * <attemptsMade>` for each job it starts, and never finishes one: the test kills it (SIGKILL) or
 * asks it to stop (SIGTERM, which closes the worker with a short grace and prints `CLOSED`).
 * It rings its own bell, since a `MemoryTransport` is private to a process.
 *
 * Arguments: database url, schema, namespace, queue, lock duration (ms), grace (ms).
 */
import { MemoryTransport } from '@qelay-cloud/transport-local';
import { Worker } from '../src';

const [url, schema, namespace, queue, lockDuration, grace] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
  string,
];

const transport = new MemoryTransport();
const worker = new Worker(
  queue,
  (job, { signal }) => {
    console.log(`STARTED ${job.id} ${job.attemptsMade}`);
    return new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
    });
  },
  {
    databaseUrl: url,
    database: { schema, poolSize: 3 },
    namespace,
    transport,
    lockDuration: Number(lockDuration),
    heartbeatInterval: 0,
  }
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
