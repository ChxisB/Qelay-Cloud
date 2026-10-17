/**
 * An in-process tick loop in its own process, for the election tests. It prints `READY` once its
 * first beat is done and `TICK <holder> <epoch ms>` for every beat that held the lease and ran a
 * tick. The test kills it (SIGKILL: no lease release) or asks it to stop (SIGTERM, which stops the
 * loop, so the lease is given up, and prints `STOPPED`).
 *
 * Arguments: database url, schema, namespace, holder, interval (ms), lease (ms).
 */
import { openDatabase, PostgresStore } from '@qelay-cloud/store-postgres';
import { MemoryTransport } from '@qelay-cloud/transport-local';
import { TickLoop } from '../src/loop';

const [url, schema, namespace, holder, interval, lease] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
  string,
];

const store = new PostgresStore({
  db: openDatabase({ url, schema, poolSize: 2, applicationName: `qcloud:election:${holder}` }),
  namespace,
});
const transport = new MemoryTransport();
const loop = new TickLoop(
  {
    store,
    transport,
    telemetry: {
      duration: (step) => {
        if (step === 'pass') console.log(`TICK ${holder} ${Date.now()}`);
      },
      gauge() {},
      error: (step, error) =>
        console.log(`ERROR ${step} ${error instanceof Error ? error.message : String(error)}`),
    },
  },
  { holder, intervalMs: Number(interval), leaseMs: Number(lease), ringGraceMs: 0 }
);

process.on('SIGTERM', () => {
  void loop.stop({ timeout: 2_000 }).then(() => {
    console.log('STOPPED');
    process.exit(0);
  });
});

await loop.beat();
loop.start();
console.log('READY');
