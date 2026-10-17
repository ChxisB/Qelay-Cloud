import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { Delivery, SubscribeOptions, Subscription } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { MALFORMED_BELL_RETRY_MS } from '../src/workerClaim';
import type { SdkFixture } from './support';
import { FlakyTransport, openFixture, recorded, resetFixture } from './support';
import { until, workerKit } from './workerSupport';

/** Keeps the worker's handler, so a test can hand it any delivery a broker could. */
class Capturing extends FlakyTransport {
  handler: ((delivery: Delivery) => Promise<void>) | null = null;

  override subscribe(
    queue: string,
    handler: (delivery: Delivery) => Promise<void>,
    options: SubscribeOptions
  ): Subscription {
    this.handler = handler;
    return super.subscribe(queue, handler, options);
  }
}

function delivery(settled: string[]): Delivery {
  return {
    bell: null,
    attempt: 3,
    ack: async () => void settled.push('ack'),
    nack: async (retryInMs) => void settled.push(`nack:${retryInMs}`),
  };
}

describeDb('worker: a delivery that is not a bell', () => {
  let f: SdkFixture;
  const kit = workerKit(() => f);
  beforeAll(async () => {
    f = await openFixture();
  });
  afterAll(async () => {
    await f.drop();
  });
  beforeEach(async () => {
    await resetFixture(f);
  });
  afterEach(async () => {
    await kit.closeAll();
  });

  test('is counted and returned to the broker, so a broker with a dead-letter queue keeps it there', async () => {
    const transport = new Capturing();
    const seen = recorded();
    kit.worker('malformed', () => 'never', { transport, metrics: seen.metrics });
    await until('the worker to subscribe', () => transport.handler !== null);
    const settled: string[] = [];
    await transport.handler!(delivery(settled));
    // An ack would delete the body: no dead-letter queue entry, no metric, and nobody would know.
    expect(settled).toEqual([`nack:${MALFORMED_BELL_RETRY_MS}`]);
    expect(seen.counts.get('qcloud.worker.malformed_bell')).toBe(1);
  });

  test('does not stop the worker: a job added afterwards still runs', async () => {
    const transport = new Capturing();
    const ran: string[] = [];
    kit.worker('malformed', (job) => void ran.push(job.id), { transport });
    await until('the worker to subscribe', () => transport.handler !== null);
    await transport.handler!(delivery([]));
    const job = await f.queue('malformed', { transport }).add('after', {});
    await until('the job to run', () => ran.includes(job.id));
  });
});
