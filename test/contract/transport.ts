import { describe, test } from 'bun:test';
import { behaviourContract } from './behaviour';
import { capabilityContract } from './capability';
import type { ContractContext } from './context';
import { coreContract } from './core';
import { faultContract } from './faults';
import type { ContractOptions, HarnessFactory } from './harness';
import { bell } from './harness';

export { bell };
export type { ContractOptions, HarnessFactory, TransportHarness } from './harness';

/** A test that waits for several redeliveries (a dead letter) gets this many times the suite timeout. */
const SLOW_FACTOR = 3;

/**
 * The contract suite for `DeliveryTransport`: what every implementation must do, so the worker can
 * treat the cloud queue as a fungible doorbell. Memory and Postgres run it in process, Pub/Sub and SQS
 * on their emulators, and a real cloud under `QCLOUD_REAL_CLOUD=1` (task 43). It asserts the settled
 * interface and the declared capabilities, never a vendor: a difference between transports is a
 * capability flag, a skip with a reason, or a failure.
 *
 * The tests are in four groups so each file stays small: `core.ts` (the v1 behaviours),
 * `behaviour.ts` (failed handlers, concurrency, shutdown), `capability.ts` (what depends on the
 * declared capabilities) and `faults.ts` (a broker that misbehaves).
 */
export function describeTransportContract(
  name: string,
  make: HarnessFactory,
  options: ContractOptions = {}
): void {
  describe(`DeliveryTransport contract: ${name}`, () => {
    const slowTimeout = (options.timeoutMs ?? 5_000) * SLOW_FACTOR;
    const context: ContractContext = {
      it: (title, run) => test(title, run, options.timeoutMs),
      slow: (title, run) => test(title, run, slowTimeout),
      optional(behaviour, title, run, slow = false) {
        const reason = options.skips?.[behaviour];
        if (reason !== undefined) {
          test.skip(`${title} [skipped: ${reason}]`, run);
          return;
        }
        test(title, run, slow ? slowTimeout : options.timeoutMs);
      },
      async using(run) {
        const harness = await make();
        try {
          await run(harness);
        } finally {
          await harness.close();
        }
      },
    };
    coreContract(context);
    behaviourContract(context);
    capabilityContract(context);
    faultContract(context);
  });
}
