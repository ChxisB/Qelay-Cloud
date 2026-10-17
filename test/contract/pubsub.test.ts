import { environmentNames, PubSubTransport } from '../../packages/transport-gcp/src';
import {
  describePubsub,
  emulatorClient,
  emulatorHost,
  openEnvironment,
} from '../../packages/transport-gcp/test/support';
import { TcpProxy } from '../support/tcpProxy';
import { CONTRACT_SKIPS } from './skips';
import type { TransportHarness } from './transport';
import { describeTransportContract } from './transport';

/**
 * Time the emulator needs to open a stream, route a bell to it and run the handler. A pass is
 * a bell delivered inside it, so this is generous; a test that is flaky here has a real bug.
 */
const SETTLE_MS = 800;
/** A bell nobody settled is nacked at once and comes back after the retry backoff (at most 1 s here). */
const REDELIVERY_AFTER_MS = 2_500;
/** A test that waits for a redelivery takes 4 to 5 s with the topology set up, close to Bun's 5 s default. */
const TEST_TIMEOUT_MS = 30_000;
/** Five deliveries at the longest backoff of the fast topology, with room for the emulator. */
const DEAD_LETTER_AFTER_MS = 40_000;
/** A ring during an outage gives up after this, so the test does not wait out the default budget. */
const RING_RETRY_BUDGET_MS = 2_000;

describePubsub('PubSubTransport', () => {
  describeTransportContract(
    'pubsub-emulator',
    async () => {
      const env = await openEnvironment({ namespace: 'contract', queues: ['q', 'q1', 'q2'] });
      // The transport reaches the emulator through a proxy, so the outage test can cut the network.
      const [host, port] = emulatorHost().split(':');
      const proxy = await TcpProxy.start({
        targetHost: host ?? '127.0.0.1',
        targetPort: Number(port),
      });
      const client = emulatorClient(`127.0.0.1:${proxy.port}`);
      const transport = new PubSubTransport({
        namespace: 'contract',
        client,
        maxHeld: 8,
        ringRetryBudgetMs: RING_RETRY_BUDGET_MS,
        // No Cloud Monitoring on an emulator: `stats` answers "unavailable".
      });
      const settle = () => Bun.sleep(SETTLE_MS);
      const harness: TransportHarness = {
        transport,
        redeliveryAfterMs: REDELIVERY_AFTER_MS,
        deadLetterAfterMs: DEAD_LETTER_AFTER_MS,
        outage: { sever: () => proxy.refuse(), restore: () => proxy.accept() },
        async advance(ms) {
          await Bun.sleep(ms);
          await settle();
        },
        settle,
        async poison(queue) {
          await env.pubsub.topic(environmentNames('contract').topic).publishMessage({
            data: Buffer.from('this is not a bell'),
            attributes: { route: env.names(queue).route },
          });
        },
        async close() {
          await transport.close();
          await client.close().catch(() => {});
          await proxy.stop();
          await env.destroy();
        },
      };
      return harness;
    },
    { timeoutMs: TEST_TIMEOUT_MS, skips: CONTRACT_SKIPS['pubsub-emulator'] }
  );
});
