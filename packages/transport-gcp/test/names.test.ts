import { describe, expect, test } from 'bun:test';
import { TransportError } from '@qelay-cloud/core';
import {
  decodeBell,
  decodeName,
  encodeBell,
  encodeName,
  environmentNames,
  MAX_RESOURCE_ID_LENGTH,
  queueNames,
  queueOfSubscription,
} from '../src';

const RESOURCE_ID = /^[A-Za-z][A-Za-z0-9\-_.~+%]{2,254}$/;
const NAMES = [
  'emails',
  'a.b',
  'a_b',
  'a-b',
  'A B',
  'ünï',
  '日本語',
  '',
  'x'.repeat(40),
  '"quoted"',
  'a\\b',
  '_41',
];

describe('resource names', () => {
  test('a name of letters, digits and dashes is its own encoding', () => {
    expect(encodeName('emails-2')).toBe('emails-2');
  });

  test('every name round-trips and the encoding is injective', () => {
    const seen = new Map<string, string>();
    for (const name of NAMES) {
      const encoded = encodeName(name);
      expect(decodeName(encoded)).toBe(name);
      expect(seen.get(encoded)).toBeUndefined();
      seen.set(encoded, name);
    }
  });

  test('"." and "_" never survive encoding, so "." can separate the parts of an id', () => {
    for (const name of NAMES) expect(encodeName(name)).toMatch(/^[A-Za-z0-9\-_]*$/);
    expect(encodeName('a.b')).not.toBe(encodeName('a_2eb'));
    expect(encodeName('a.b')).toBe('a_2eb');
  });

  test('only the spelling encodeName makes decodes', () => {
    expect(decodeName('_41')).toBeNull();
    expect(decodeName('_2E')).toBeNull();
    expect(decodeName('a b')).toBeNull();
    expect(decodeName('_zz')).toBeNull();
    expect(decodeName('_c3')).toBeNull();
  });

  test('queue names are valid Pub/Sub ids, and the filter has nothing to escape', () => {
    for (const queue of NAMES.filter((name) => name !== '')) {
      const names = queueNames('prod', queue);
      expect(names.subscription).toMatch(RESOURCE_ID);
      expect(names.deadLetterSubscription).toMatch(RESOURCE_ID);
      expect(names.filter).toBe(`attributes.route = "${names.route}"`);
      expect(names.route).not.toMatch(/["\\]/);
    }
    const env = environmentNames('prod');
    expect(env.topic).toBe('qcloud.prod.bells');
    expect(env.deadLetterTopic).toBe('qcloud.prod.bells-dlq');
    expect(queueNames('prod', 'emails').subscription).toBe('qcloud.prod.sub.emails');
  });

  test('two queues, or two namespaces, never share a subscription or a route', () => {
    const a = queueNames('prod', 'a.b');
    expect(queueNames('prod', 'a_2eb').subscription).not.toBe(a.subscription);
    expect(queueNames('prod', 'a_2eb').route).not.toBe(a.route);
    expect(queueNames('prod2', 'a.b').route).not.toBe(a.route);
    expect(queueNames('a.b', 'q').route).not.toBe(queueNames('a', 'b.q').route);
  });

  test('a subscription id maps back to its queue, for the panel', () => {
    for (const queue of NAMES.filter((name) => name !== '')) {
      const names = queueNames('ns.1', queue);
      expect(queueOfSubscription(names.subscription)).toEqual({
        namespace: 'ns.1',
        queue,
        deadLetter: false,
      });
      expect(queueOfSubscription(names.deadLetterSubscription)).toEqual({
        namespace: 'ns.1',
        queue,
        deadLetter: true,
      });
    }
    expect(queueOfSubscription('somebody-elses-subscription')).toBeNull();
    expect(queueOfSubscription('qcloud.prod.bells')).toBeNull();
    expect(queueOfSubscription('qcloud.prod.sub.a.b')).toBeNull();
  });

  test('a name that cannot be an id is a TransportError, not a broken resource', () => {
    expect(() => queueNames('prod', '')).toThrow(TransportError);
    expect(() => queueNames('', 'q')).toThrow(TransportError);
    expect(() => environmentNames('')).toThrow(TransportError);
    const tooLong = 'q'.repeat(MAX_RESOURCE_ID_LENGTH);
    expect(() => queueNames('prod', tooLong)).toThrow(/at most 255/);
  });
});

describe('bell encoding', () => {
  const expected = { namespace: 'prod', queue: 'emails' };

  test('a bell survives the wire and carries the route the subscription filters on', () => {
    const bell = { namespace: 'prod', queue: 'emails', jobId: 'job-1' };
    const wire = encodeBell(bell);
    expect(decodeBell(wire.data, expected)).toEqual(bell);
    expect(wire.attributes).toEqual({
      route: queueNames('prod', 'emails').route,
      namespace: 'prod',
      queue: 'emails',
    });
  });

  test('a bell without a job id stays without one', () => {
    const wire = encodeBell({ namespace: 'prod', queue: 'emails' });
    expect(decodeBell(wire.data, expected)).toEqual({ namespace: 'prod', queue: 'emails' });
    expect(JSON.parse(wire.data.toString())).toEqual({ namespace: 'prod', queue: 'emails' });
  });

  test('a body that is not a bell for this subscription decodes to null', () => {
    const body = (value: unknown) =>
      Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    expect(decodeBell(body('not json'), expected)).toBeNull();
    expect(decodeBell(body('null'), expected)).toBeNull();
    expect(decodeBell(body([]), expected)).toBeNull();
    expect(decodeBell(body({ queue: 'emails' }), expected)).toBeNull();
    expect(decodeBell(body({ namespace: 'prod', queue: 'other' }), expected)).toBeNull();
    expect(decodeBell(body({ namespace: 'other', queue: 'emails' }), expected)).toBeNull();
    expect(decodeBell(body({ namespace: 'prod', queue: 'emails', jobId: 7 }), expected)).toBeNull();
    expect(decodeBell(new Uint8Array([0xff, 0xfe]), expected)).toBeNull();
  });

  test('a queue that cannot be a subscription name cannot be encoded', () => {
    expect(() => encodeBell({ namespace: 'prod', queue: '' })).toThrow(TransportError);
  });
});
