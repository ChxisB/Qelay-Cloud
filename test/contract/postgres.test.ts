import { afterAll, beforeAll } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { PostgresLocalTransport } from '@qelay-cloud/transport-local';
import type { TestStore } from '../../packages/store-postgres/test/storeHelpers';
import { enqueueN, openTestStore } from '../../packages/store-postgres/test/storeHelpers';
import { describeDb } from '../support/db';
import { CONTRACT_SKIPS } from './skips';
import type { TransportHarness } from './transport';
import { describeTransportContract } from './transport';

const POLL_MS = 25;
const VISIBILITY_TIMEOUT_MS = 300;
/** Notifications cross the database and the loopback, then a poll turn may run the timers: a few polls cover it. */
const SETTLE_MS = POLL_MS * 4;

describeDb('PostgresLocalTransport', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ clock: null, namespace: 'contract' });
  });
  afterAll(async () => {
    await t.drop();
  });

  describeTransportContract(
    'postgres-local',
    async () => {
      // Jobs left claimable by an earlier test are wake-ups for this one: start from an empty store.
      await t.fresh.sql`TRUNCATE qcloud_jobs`;
      const transport = new PostgresLocalTransport({
        db: t.fresh.db,
        source: t.store.doorbell,
        namespace: 'contract',
        channel: `qcloud_contract_${randomBytes(6).toString('hex')}`,
        pollIntervalMs: POLL_MS,
        visibilityTimeoutMs: VISIBILITY_TIMEOUT_MS,
        heartbeatMs: 1_000,
      });
      // A bell rung before `LISTEN` is registered is lost to `NOTIFY` and found by the poll only
      // when the store has a job for it; these bells have none. Warm the connection up first.
      const warmup = transport.subscribe('warmup', async () => {}, { capacity: () => 0 });
      await transport.ready();
      const settle = () => Bun.sleep(SETTLE_MS);
      const harness: TransportHarness = {
        transport,
        redeliveryAfterMs: VISIBILITY_TIMEOUT_MS,
        async advance(ms) {
          await Bun.sleep(ms);
          await settle();
        },
        settle,
        async backlog(queue, count) {
          await t.fresh.sql`TRUNCATE qcloud_jobs`;
          await enqueueN(t.store, count, {}, queue);
        },
        async close() {
          await warmup.close();
          await transport.close();
        },
      };
      return harness;
    },
    { skips: CONTRACT_SKIPS['postgres-local'] }
  );
});
