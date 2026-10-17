import { SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  describeSqs,
  openEnvironment,
  sqsEndpoint,
  transportFor,
} from '../../packages/transport-aws/test/support';
import { TcpProxy } from '../support/tcpProxy';
import type { TransportHarness } from './harness';
import { CONTRACT_SKIPS } from './skips';
import { describeTransportContract } from './transport';

/**
 * Time the emulator needs to hand a bell to a long poll that is already waiting, and to run the
 * handler. Generous: a test that is flaky here has a real bug. It stays below the one-second delay
 * granularity so that "not before its delay" is observable.
 */
const SETTLE_MS = 600;
/**
 * How long a bell nobody settled can take to come back: an unsettled handler is nacked at once, but a
 * worker that died holds it for the 3 s visibility timeout these tests configure.
 */
const REDELIVERY_AFTER_MS = 3_500;
const TEST_TIMEOUT_MS = 30_000;
/** Five receives of 3 s visibility at the most, with room for the emulator. */
const DEAD_LETTER_AFTER_MS = 25_000;
/** A ring during an outage gives up after this, so the test does not wait out the default budget. */
const RING_RETRY_BUDGET_MS = 2_000;

describeSqs('SqsTransport', () => {
  describeTransportContract(
    'sqs-emulator',
    async () => {
      const env = await openEnvironment({ namespace: 'contract', queues: ['q', 'q1', 'q2'] });
      // The transport reaches the emulator through a proxy, so the outage test can cut the network.
      const target = new URL(sqsEndpoint());
      const proxy = await TcpProxy.start({
        targetHost: target.hostname,
        targetPort: Number(target.port),
      });
      const transport = transportFor('contract', {
        endpoint: `http://127.0.0.1:${proxy.port}`,
        ringRetryBudgetMs: RING_RETRY_BUDGET_MS,
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
          await env.client.send(
            new SendMessageCommand({
              QueueUrl: env.provisioned(queue).queueUrl,
              MessageBody: 'this is not a bell {',
            })
          );
        },
        async close() {
          await transport.close();
          await proxy.stop();
          await env.destroy();
        },
      };
      return harness;
    },
    { timeoutMs: TEST_TIMEOUT_MS, skips: CONTRACT_SKIPS['sqs-emulator'] }
  );
});
