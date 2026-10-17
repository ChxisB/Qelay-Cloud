/**
 * A doorbell worker the crash scenarios kill with SIGKILL. It claims one job from the first bell,
 * prints the lease as a JSON line, then hangs, either before the ack (the bell is redelivered) or
 * after it (the bell is gone). After the ack it prints `acked` once the client's ack batch has had
 * time to flush.
 *
 *   bun crashingWorker.ts <schema> <namespace> <queue> <before-ack|after-ack> <leaseMs>
 *
 * The database comes from `QCLOUD_TEST_DATABASE_URL` and the emulator from
 * `QCLOUD_PUBSUB_EMULATOR_HOST`, as in the parent test.
 */
import { testDatabaseUrl } from '../../../test/support/db';
import { Ledger } from '../../../test/support/doorbell/ledger';
import { openDatabase } from '../../store-postgres/src/connection/connect';
import { PostgresStore } from '../../store-postgres/src/postgresStore';
import { startWorker } from './testWorker';

const [schema, namespace, queue, mode, leaseMs] = process.argv.slice(2);
if (
  !schema ||
  !namespace ||
  !queue ||
  !leaseMs ||
  (mode !== 'before-ack' && mode !== 'after-ack')
) {
  throw new Error('usage: crashingWorker <schema> <namespace> <queue> <before-ack|after-ack> <ms>');
}

const forever = () => new Promise<never>(() => {});
const db = openDatabase({
  url: testDatabaseUrl(),
  schema,
  poolSize: 2,
  applicationName: `qcloud:crasher-${process.pid}`,
});
// A heartbeat extends to the store's lease length, so the store is built with the worker's.
const store = new PostgresStore({ db, namespace, leaseMs: Number(leaseMs) });
startWorker(store, namespace, new Ledger(), {
  owner: `crasher-${process.pid}`,
  queues: [queue],
  concurrency: 1,
  leaseMs: Number(leaseMs),
  hooks: {
    async beforeAck(claimed) {
      const [claim] = claimed;
      if (!claim) return;
      console.log(
        JSON.stringify({ id: claim.id, token: claim.lease.token, leaseUntil: claim.leaseUntil })
      );
      if (mode === 'before-ack') await forever();
    },
  },
  async process() {
    await Bun.sleep(1_000);
    console.log('acked');
    return await forever();
  },
});
