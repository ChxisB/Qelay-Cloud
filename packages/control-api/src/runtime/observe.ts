import type { DeadLetterPeek, DeliveryTransport } from '@qelay-cloud/core';
import { canPeekDeadLetters } from '@qelay-cloud/core';
import type { TransportReachability } from '../readiness';

/**
 * The transport, with every call to the broker noted in `reachability`. The service holds no
 * connection to the broker only to be asked about it (see `TransportReachability`), so the routes'
 * own rings and reads are the observations: a ring the broker could not take, or any call that
 * threw, is `failed`; a call that answered is `ok`.
 *
 * Each member is delegated by hand: a transport keeps its state in `#private` fields, which a
 * wrapper made with `Object.create` could not reach.
 */
export function observeReachability(
  inner: DeliveryTransport,
  reachability: Pick<TransportReachability, 'record'>
): DeliveryTransport {
  const observed = async <T>(call: () => Promise<T>, ok: (value: T) => boolean): Promise<T> => {
    try {
      const value = await call();
      reachability.record(ok(value));
      return value;
    } catch (error) {
      reachability.record(false);
      throw error;
    }
  };
  const wrapped: DeliveryTransport & Partial<DeadLetterPeek> = {
    capabilities: inner.capabilities,
    ring: (items) =>
      items.length === 0
        ? inner.ring(items)
        : observed(
            () => inner.ring(items),
            (results) => !results.some((result) => !result.ok && result.reason === 'unreachable')
          ),
    subscribe: (queue, handler, options) => inner.subscribe(queue, handler, options),
    stats: (queue) =>
      observed(
        () => inner.stats(queue),
        () => true
      ),
    close: () => inner.close(),
  };
  if (canPeekDeadLetters(inner)) {
    wrapped.peekDeadLetters = (queue, limit) =>
      observed(
        () => inner.peekDeadLetters(queue, limit),
        () => true
      );
  }
  return wrapped;
}
