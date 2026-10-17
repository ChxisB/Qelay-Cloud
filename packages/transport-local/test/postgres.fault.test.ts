import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { Delivery } from '@qelay-cloud/core';
import { SQL } from 'bun';
import { describeDb } from '../../../test/support/db';
import { TcpProxy } from '../../../test/support/tcpProxy';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { enqueueN, openTestStore } from '../../store-postgres/test/storeHelpers';
import type { PostgresLocalTransport } from '../src';
import {
  countingSource,
  databaseTarget,
  killListeners,
  listenerPids,
  makeTransport,
  uniqueChannel,
  waitFor,
  worker,
  wrapDatabase,
} from './support';

const bell = (jobId?: string) => ({ namespace: 'test', queue: 'q', ...(jobId && { jobId }) });

describeDb('PostgresLocalTransport when the LISTEN connection fails', () => {
  let t: TestStore;
  const open: PostgresLocalTransport[] = [];
  const proxies: TcpProxy[] = [];
  const track = (transport: PostgresLocalTransport) => {
    open.push(transport);
    return transport;
  };

  beforeAll(async () => {
    t = await openTestStore({ clock: null });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.fresh.sql`TRUNCATE qcloud_jobs, qcloud_queue_state`;
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((transport) => transport.close()));
    await Promise.all(proxies.splice(0).map((proxy) => proxy.stop()));
  });

  test('a bell rung while the connection is down is lost to NOTIFY and found by the poll', async () => {
    const channel = uniqueChannel();
    const transport = track(makeTransport(t, { channel, pollIntervalMs: 150, heartbeatMs: 5_000 }));
    const done: string[] = [];
    const seen: Delivery[] = [];
    transport.subscribe('q', worker(t, done, seen), { capacity: () => 5 });
    await transport.ready();
    await killListeners(t, channel);
    await waitFor(async () => (await listenerPids(t, channel)).length === 0, 'the backend to go');
    const [id] = await enqueueN(t.store, 1);
    await transport.ring([{ bell: bell(id) }]);
    await waitFor(() => done.length === 1, 'the job completed', 6_000);
    // The bell with the job id never arrived: what woke the worker is the poll's own bell.
    expect(seen.map((delivery) => delivery.bell?.jobId)).toEqual([undefined]);
  });

  test('after a loss the connection is replaced and a later ring wakes the worker at once', async () => {
    const channel = uniqueChannel();
    const source = countingSource(t);
    const transport = track(
      makeTransport(t, { channel, source, pollIntervalMs: 10_000, heartbeatMs: 100 })
    );
    const done: string[] = [];
    transport.subscribe('q', worker(t, done), { capacity: () => 5 });
    await transport.ready();
    await waitFor(() => source.probes === 1, 'the first poll turn');
    await killListeners(t, channel);
    await waitFor(
      () => transport.listenerReconnects >= 1 && transport.listening,
      'the connection to be replaced'
    );
    await waitFor(() => source.probes >= 2, 'the catch-up poll after the gap');
    const probes = source.probes;
    const [id] = await enqueueN(t.store, 1);
    await transport.ring([{ bell: bell(id) }]);
    await waitFor(() => done.length === 1, 'the job completed', 3_000);
    expect(source.probes).toBe(probes);
    expect((await listenerPids(t, channel)).length).toBe(1);
  });

  test('a connection that stops delivering without failing is noticed and replaced', async () => {
    const target = databaseTarget();
    const proxy = await TcpProxy.start({ targetHost: target.host, targetPort: target.port });
    proxies.push(proxy);
    const viaProxy = new URL(target.url);
    viaProxy.hostname = '127.0.0.1';
    viaProxy.port = String(proxy.port);
    const db = wrapDatabase(t.fresh.db, {
      openListener: () => new SQL({ url: viaProxy.toString(), max: 1, connectionTimeout: 2 }),
    });
    const channel = uniqueChannel();
    const transport = track(
      makeTransport(t, { db, channel, pollIntervalMs: 100, heartbeatMs: 100 })
    );
    const done: string[] = [];
    transport.subscribe('q', worker(t, done), { capacity: () => 5 });
    await transport.ready();
    expect(transport.listening).toBe(true);

    proxy.blackhole(true);
    await waitFor(() => !transport.listening, 'the silent connection to be given up', 5_000);
    // The poll does not depend on it.
    await enqueueN(t.store, 1);
    await waitFor(() => done.length === 1, 'the job found by the poll', 5_000);

    proxy.blackhole(false);
    proxy.sever();
    await waitFor(
      () => transport.listening && transport.listenerReconnects >= 1,
      'the connection to come back',
      15_000
    );
    const [id] = await enqueueN(t.store, 1);
    await transport.ring([{ bell: bell(id) }]);
    await waitFor(() => done.length === 2, 'the second job completed');
  });

  test('a database that is unreachable at the start is retried until it is not', async () => {
    const target = databaseTarget();
    const proxy = await TcpProxy.start({ targetHost: target.host, targetPort: target.port });
    proxies.push(proxy);
    const viaProxy = new URL(target.url);
    viaProxy.hostname = '127.0.0.1';
    viaProxy.port = String(proxy.port);
    await proxy.refuse();
    const db = wrapDatabase(t.fresh.db, {
      openListener: () => new SQL({ url: viaProxy.toString(), max: 1, connectionTimeout: 1 }),
    });
    const transport = track(
      makeTransport(t, { db, pollIntervalMs: 50, heartbeatMs: 100, channel: uniqueChannel() })
    );
    const done: string[] = [];
    transport.subscribe('q', worker(t, done), { capacity: () => 5 });
    await transport.ready();
    expect(transport.listening).toBe(false);
    // Poll mode in all but name: work is found while there is no connection.
    await enqueueN(t.store, 1);
    await waitFor(() => done.length === 1, 'the job found by the poll');
    await proxy.accept();
    await waitFor(() => transport.listening, 'the first connection', 15_000);
  });
});
