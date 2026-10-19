import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { resetTables } from '../../store-postgres/test/finishHelpers';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import {
  addHook,
  event,
  journal,
  KEY,
  rawDeliveries,
} from '../../store-postgres/test/webhookHelpers';
import { noTelemetry } from '../src/telemetry';
import { resolveWebhookConfig } from '../src/webhookConfig';
import { pooledSending, runWebhookLoop } from '../src/webhookLoop';
import { listener } from './webhookSockets';

describeDb('webhook sender process: the loop on a real store and real sockets', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ webhookKey: KEY, poolSize: 8 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  test('every delivery arrives once, over a few kept connections', async () => {
    const receiver = listener((socket) =>
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n')
    );
    try {
      for (const name of ['a', 'b', 'c']) {
        await addHook(t, { url: `http://127.0.0.1:${receiver.port}/${name}` });
      }
      await journal(
        t,
        Array.from({ length: 20 }, (_, n) => event('pushed', 'q', `j${n}`))
      );
      const config = resolveWebhookConfig(
        { concurrency: 8, perDestination: 4, ratePerMinute: 100_000, idleMs: 20 },
        { allowHttp: true, allowPrivate: true }
      )!;
      const pooled = pooledSending(config);
      const stop = new AbortController();
      const loop = runWebhookLoop(
        t.store,
        { ...pooled.sending, now: () => t.clock.now() },
        noTelemetry,
        stop.signal
      );
      const deadline = Date.now() + 10_000;
      while (receiver.requests.length < 60 && Date.now() < deadline) await Bun.sleep(10);
      // Recording follows the last answer by one flush; stopping waits for it.
      stop.abort();
      await loop;
      pooled.close();

      expect(receiver.requests).toHaveLength(60);
      const rows = await rawDeliveries(t);
      expect(rows).toHaveLength(60);
      expect(rows.every((row) => row.status === 'delivered')).toBe(true);
      // No more connections than the destination allows at once, plus the odd replacement.
      expect(receiver.connections()).toBeLessThanOrEqual(8);
    } finally {
      receiver.stop();
    }
  });
});
