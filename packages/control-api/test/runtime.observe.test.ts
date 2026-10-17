import { describe, expect, test } from 'bun:test';
import type { DeadLetterPeek, DeliveryTransport, RingResult } from '@qelay-cloud/core';
import { canPeekDeadLetters } from '@qelay-cloud/core';
import { MemoryTransport } from '@qelay-cloud/transport-local';
import { ManualClock } from '../../../test/support/clock';
import { observeReachability, TransportReachability } from '../src';

const ITEM = { bell: { queue: 'q', namespace: 'default' }, delayMs: 0 };

/** A transport whose next ring answers as the test says. Its state is private, as a real one's is. */
class Scripted {
  #next: RingResult[] | Error = [{ ok: true }];
  readonly capabilities = new MemoryTransport().capabilities;
  answer(next: RingResult[] | Error): void {
    this.#next = next;
  }
  async ring(): Promise<RingResult[]> {
    if (this.#next instanceof Error) throw this.#next;
    return this.#next;
  }
  subscribe = (): never => {
    throw new Error('not used');
  };
  async stats(): Promise<never> {
    if (this.#next instanceof Error) throw this.#next;
    return { depth: 0 } as never;
  }
  async close(): Promise<void> {}
}

function observe(inner: DeliveryTransport) {
  const clock = new ManualClock(1_000);
  const reachability = new TransportReachability(clock, 60_000);
  return { transport: observeReachability(inner, reachability), reachability, clock };
}

describe('observeReachability', () => {
  test('is unknown until the broker has been used, then follows what it said', async () => {
    const inner = new Scripted();
    const { transport, reachability } = observe(inner as unknown as DeliveryTransport);
    expect(reachability.state()).toBe('unknown');

    await transport.ring([ITEM] as never);
    expect(reachability.state()).toBe('ok');

    inner.answer([{ ok: false, reason: 'unreachable' }]);
    await transport.ring([ITEM] as never);
    expect(reachability.state()).toBe('failed');

    inner.answer([{ ok: true }]);
    await transport.ring([ITEM] as never);
    expect(reachability.state()).toBe('ok');
  });

  test('a bell the broker refused is not an outage', async () => {
    const inner = new Scripted();
    inner.answer([{ ok: false, reason: 'rejected' }]);
    const { transport, reachability } = observe(inner as unknown as DeliveryTransport);
    await transport.ring([ITEM] as never);
    expect(reachability.state()).toBe('ok');
  });

  test('a call that throws is a failure, and the error still reaches the caller', async () => {
    const inner = new Scripted();
    inner.answer(new Error('connect ECONNREFUSED'));
    const { transport, reachability } = observe(inner as unknown as DeliveryTransport);
    await expect(transport.ring([ITEM] as never)).rejects.toThrow('ECONNREFUSED');
    expect(reachability.state()).toBe('failed');
    await expect(transport.stats('q')).rejects.toThrow('ECONNREFUSED');
  });

  test('ringing nothing is not an observation', async () => {
    const { transport, reachability } = observe(new Scripted() as unknown as DeliveryTransport);
    await transport.ring([]);
    expect(reachability.state()).toBe('unknown');
  });

  test('an old observation is not believed', async () => {
    const { transport, reachability, clock } = observe(
      new Scripted() as unknown as DeliveryTransport
    );
    await transport.ring([ITEM] as never);
    clock.advance(60_001);
    expect(reachability.state()).toBe('unknown');
  });

  test('keeps the dead-letter peek only when the transport has one, and observes it', async () => {
    const without = observe(new Scripted() as unknown as DeliveryTransport).transport;
    expect(canPeekDeadLetters(without)).toBe(false);

    const inner = new Scripted() as unknown as DeliveryTransport & DeadLetterPeek;
    inner.peekDeadLetters = async () => [];
    const { transport, reachability } = observe(inner);
    expect(canPeekDeadLetters(transport)).toBe(true);
    if (canPeekDeadLetters(transport)) await transport.peekDeadLetters('q', 5);
    expect(reachability.state()).toBe('ok');
  });

  test('delegates the capabilities and close', async () => {
    const inner = new MemoryTransport();
    const { transport } = observe(inner);
    expect(transport.capabilities).toBe(inner.capabilities);
    await transport.close();
  });
});
