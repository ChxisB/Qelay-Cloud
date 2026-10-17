import { randomBytes } from 'node:crypto';
import type { Delivery } from '@qelay-cloud/core';
import { testDatabaseUrl } from '../../../test/support/db';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import type { LocalDatabase, PostgresTransportOptions, QueueSource } from '../src';
import { PostgresLocalTransport } from '../src';

export const POLL_MS = 25;

export function uniqueChannel(): string {
  return `qcloud_t_${randomBytes(6).toString('hex')}`;
}

/** A source that counts what the poll loop asks of the store. */
export function countingSource(t: TestStore): QueueSource & { probes: number } {
  const source = {
    probes: 0,
    hasClaimable: async (queue: string) => {
      source.probes += 1;
      return t.store.doorbell.hasClaimable(queue);
    },
    snapshot: (queue: string) => t.store.doorbell.snapshot(queue),
  };
  return source;
}

export function makeTransport(t: TestStore, options: Partial<PostgresTransportOptions> = {}) {
  return new PostgresLocalTransport({
    db: t.fresh.db,
    source: t.store.doorbell,
    namespace: 'test',
    channel: uniqueChannel(),
    pollIntervalMs: POLL_MS,
    heartbeatMs: 1_000,
    ...options,
  });
}

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 4_000
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** What a worker does with a bell: claim one job, finish it, ack. `done` collects the finished job ids. */
export function worker(t: TestStore, done: string[], seen: Delivery[] = []) {
  return async (delivery: Delivery): Promise<void> => {
    seen.push(delivery);
    for (const job of await t.store.claim('q', 'w', 1)) {
      await t.store.complete(job.lease, 'ok');
      done.push(job.id);
    }
    await delivery.ack();
  };
}

/** The `LISTEN` backends of a channel, found by the statement they ran. */
export async function listenerPids(t: TestStore, channel: string): Promise<number[]> {
  const rows = await t.fresh.sql<{ pid: number }[]>`
    SELECT pid FROM pg_stat_activity
    WHERE pid <> pg_backend_pid() AND query ILIKE ${`LISTEN%${channel}%`}`;
  return rows.map((row) => row.pid);
}

export async function killListeners(t: TestStore, channel: string): Promise<void> {
  await t.fresh.sql`
    SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE pid <> pg_backend_pid() AND query ILIKE ${`LISTEN%${channel}%`}`;
}

/** The test database's address as a host and port, for pointing a proxy at it. */
export function databaseTarget(): { host: string; port: number; url: URL } {
  const url = new URL(testDatabaseUrl());
  return { host: url.hostname, port: Number(url.port || 5432), url };
}

export const wrapDatabase = (
  db: LocalDatabase,
  overrides: Partial<LocalDatabase>
): LocalDatabase => ({
  run: (operation, work, deadlineMs) => db.run(operation, work, deadlineMs),
  openListener: () => db.openListener(),
  ...overrides,
});
