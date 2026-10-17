import type { Delivery, DeliveryTransport, Subscription } from '@qelay-cloud/core';
import type { OptionalBehaviour, TransportHarness } from './harness';

export { bell } from './harness';

/** What each group of contract tests is given: a way to declare a test and a harness to run it on. */
export interface ContractContext {
  /** Declares a test; the suite's timeout applies. */
  readonly it: (title: string, run: () => Promise<void>) => void;
  /**
   * Declares a test of a behaviour a broker may lack. When the harness's options say it does, the test
   * is skipped with the reason in its title, never silently passed.
   */
  readonly optional: (
    behaviour: OptionalBehaviour,
    title: string,
    run: () => Promise<void>,
    slow?: boolean
  ) => void;
  /** Declares a test that needs longer than the suite's timeout (a dead letter takes several redeliveries). */
  readonly slow: (title: string, run: () => Promise<void>) => void;
  /** A fresh harness for the test, closed afterwards. */
  readonly using: (run: (harness: TransportHarness) => Promise<void>) => Promise<void>;
}

export interface Gate {
  readonly open: Promise<void>;
  release(): void;
}

export function gate(): Gate {
  let release = () => {};
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { open, release };
}

/** Waits until `check` holds, polling; throws with `what` after `timeoutMs` so a failure says which. */
export async function until(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

export interface Collected {
  readonly seen: Delivery[];
  readonly subscription: Subscription;
}

/** Subscribes to `queue` with a handler that records each delivery and acks it. */
export function collect(
  transport: DeliveryTransport,
  queue: string,
  capacity = 5,
  onDelivery: (delivery: Delivery) => Promise<void> = (delivery) => delivery.ack()
): Collected {
  const seen: Delivery[] = [];
  const subscription = transport.subscribe(
    queue,
    async (delivery) => {
      seen.push(delivery);
      await onDelivery(delivery);
    },
    { capacity: () => capacity }
  );
  return { seen, subscription };
}

export const jobIds = (seen: readonly Delivery[]): string[] =>
  seen.map((delivery) => delivery.bell?.jobId ?? '<not a bell>');
