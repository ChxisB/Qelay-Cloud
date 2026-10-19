import { expect, test } from 'bun:test';
import { StoreOverloadedError } from '@qelay-cloud/core';
import type { SQL } from 'bun';
import { resolveConnection } from '../src/connection/options';
import { ResilientPool } from '../src/connection/resilient';

const pool = (maxInFlight: number) =>
  new ResilientPool({
    open: () => ({ close: async () => {} }) as unknown as SQL,
    deadlineMs: 5_000,
    maxInFlight,
  });

test('an operation over the in-flight limit is refused at once, and a finished one frees its place', async () => {
  const p = pool(2);
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const running = gates.map((g, i) => p.run(`op${i}`, () => g.promise));

  const refused = await p.run('third', async () => 'ran').catch((e) => e);
  expect(refused).toBeInstanceOf(StoreOverloadedError);
  expect(refused).toMatchObject({ code: 'STORE_OVERLOADED', operation: 'third', limit: 2 });

  gates[0]!.resolve();
  await running[0];
  expect(await p.run('after', async () => 'ran')).toBe('ran');

  gates[1]!.resolve();
  await Promise.all(running);
  await p.close();
});

test('a failing operation frees its place too, and the default limit is 64 per pooled connection', async () => {
  const p = pool(1);
  await p.run('boom', async () => Promise.reject(new Error('x'))).catch(() => {});
  expect(await p.run('ok', async () => 1)).toBe(1);
  expect(resolveConnection({ url: 'postgres://u@127.0.0.1/d', poolSize: 3 }).maxInFlight).toBe(192);
  await p.close();
});
