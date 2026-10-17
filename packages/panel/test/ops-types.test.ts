import { describe, expect, test } from 'bun:test';
import {
  OpsParseError,
  parseDeadLetters,
  parseDeployment,
  parseTransport,
} from '../src/lib/ops/types';
import { deployment, queue, transport } from './ops.helpers';

describe('the ops responses', () => {
  test("a well-formed deployment parses and a newer server's extra fields are ignored", () => {
    const body = { ...deployment(), ok: true, somethingNew: { a: 1 } };
    const parsed = parseDeployment(body);
    expect(parsed.tick.state).toBe('ok');
    expect(parsed).not.toHaveProperty('somethingNew');
  });

  test('unread numbers stay null: unknown is never turned into zero', () => {
    const parsed = parseDeployment(
      deployment({
        connections: { inUse: null, maxConnections: null, needed: null, mode: null },
        workers: { total: null, active: null },
        doorbells: { notRung: null, oldestNotRungAgeMs: null, queuesScanned: null, partial: false },
      })
    );
    expect(parsed.connections.inUse).toBeNull();
    expect(parsed.workers.total).toBeNull();
    expect(parsed.doorbells.notRung).toBeNull();
  });

  test('a transport answer keeps a null depth null', () => {
    const parsed = parseTransport(
      transport([queue('q', { doorbellDepth: null, deadLetterDepth: null })])
    );
    expect(parsed.queues[0]!.doorbellDepth).toBeNull();
    expect(parsed.queues[0]!.deadLetterDepth).toBeNull();
  });

  test('an answer from a server that predates in-flight, delayed and approximate counts still parses', () => {
    const old = transport([queue('q')]) as Record<string, any>;
    delete old.transport.approximateCounts;
    for (const row of old.queues) {
      delete row.inFlight;
      delete row.delayed;
    }
    const parsed = parseTransport(old);
    expect(parsed.queues[0]!.inFlight).toBeNull();
    expect(parsed.queues[0]!.delayed).toBeNull();
    expect(parsed.transport.approximateCounts).toBe(false);
  });

  test.each([
    ['a string where a count is', { ...deployment(), workers: { total: 'many', active: 1 } }],
    [
      'a tick state it does not know',
      { ...deployment(), tick: { ...deployment().tick, state: 'sleepy' } },
    ],
    ['a missing section', { ...deployment(), database: undefined }],
    ['a body that is not an object', 'ok'],
  ])('refuses %s with an error that names where', (_name, body) => {
    expect(() => parseDeployment(body)).toThrow(OpsParseError);
  });

  test('the error says which answer and which field, and holds none of the body', () => {
    try {
      parseTransport({ ...transport([queue('q')]), queues: [{ queue: 'q', secret: 'hunter2' }] });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(OpsParseError);
      const message = (error as Error).message;
      expect(message).toContain('/transport');
      expect(message).not.toContain('hunter2');
    }
  });

  test('dead letters parse with a null job id for a bell that could not be decoded', () => {
    const parsed = parseDeadLetters({
      queue: 'q',
      available: true,
      reason: null,
      items: [
        {
          jobId: null,
          queue: 'q',
          deliveryCount: null,
          deadLetteredAt: null,
          ageMs: null,
          jobExists: false,
        },
      ],
      timestamp: 1,
    });
    expect(parsed.items[0]!.jobId).toBeNull();
    expect(parsed.items[0]!.deliveryCount).toBeNull();
  });

  test('an unavailable dead-letter answer carries its reason', () => {
    expect(
      parseDeadLetters({
        queue: 'q',
        available: false,
        reason: 'unreachable',
        items: [],
        timestamp: 1,
      }).reason
    ).toBe('unreachable');
    expect(() =>
      parseDeadLetters({ queue: 'q', available: false, reason: 'because', items: [], timestamp: 1 })
    ).toThrow(OpsParseError);
  });
});
