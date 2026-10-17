import { describe, expect, test } from 'bun:test';
import { TransportError } from '@qelay-cloud/core';
import { decodeName, encodeName, MAX_QUEUE_NAME_LENGTH, queueNames, queueOfName } from '../src';

const SQS_NAME = /^[A-Za-z0-9_-]{1,80}$/;

describe('encodeName / decodeName', () => {
  const samples = [
    'emails',
    'a.b',
    'a_2eb',
    'a-b',
    'a__b',
    'ünï-cödé',
    '日本語',
    'with space',
    '%2e',
    '_',
  ];

  test('round-trips every sample, and the encoding is SQS-safe', () => {
    for (const sample of samples) {
      const encoded = encodeName(sample);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeName(encoded)).toBe(sample);
    }
  });

  test('an underscore is always followed by two hex digits, so `__` never occurs inside a name', () => {
    for (const sample of samples) expect(encodeName(sample)).not.toContain('__');
    expect(encodeName('a__b')).toBe('a_5f_5fb');
  });

  test('names that look alike encode apart', () => {
    const encoded = ['a.b', 'a_2eb', 'a-b'].map(encodeName);
    expect(new Set(encoded).size).toBe(3);
  });

  test('only the canonical spelling decodes', () => {
    expect(decodeName('_41')).toBeNull();
    expect(decodeName('a_2E')).toBeNull();
    expect(decodeName('a_')).toBeNull();
    expect(decodeName('a b')).toBeNull();
    expect(decodeName('_ff')).toBeNull();
  });
});

describe('queueNames', () => {
  test('a plain pair is readable, and the dead-letter queue is the queue plus a suffix', () => {
    const names = queueNames('prod', 'emails');
    expect(names).toMatchObject({
      queue: 'qcloud-prod__emails',
      deadLetter: 'qcloud-prod__emails__dlq',
      hashed: false,
    });
    expect(names.tags).toEqual({ 'qelay:namespace': 'prod', 'qelay:queue': 'emails' });
  });

  test('every name fits SQS, including the hashed form of a very long pair', () => {
    for (const [namespace, queue] of [
      ['prod', 'emails'],
      ['prod', 'q'.repeat(200)],
      ['n'.repeat(60), 'q'.repeat(60)],
      ['prod', '日本語'.repeat(30)],
      ['prod', 'a.b/c d'.repeat(20)],
    ] as const) {
      const names = queueNames(namespace, queue);
      expect(names.queue).toMatch(SQS_NAME);
      expect(names.deadLetter).toMatch(SQS_NAME);
      expect(names.deadLetter.length).toBeLessThanOrEqual(MAX_QUEUE_NAME_LENGTH);
    }
    expect(queueNames('prod', 'q'.repeat(200)).hashed).toBe(true);
  });

  test('a hashed name is stable, never equals a plain one, and tells long queues apart', () => {
    const long = 'q'.repeat(100);
    const a = queueNames('prod', `${long}a`);
    const b = queueNames('prod', `${long}b`);
    expect(queueNames('prod', `${long}a`)).toEqual(a);
    expect(a.queue).not.toBe(b.queue);
    expect(a.queue).not.toContain('__');
    expect(a.queue.startsWith('qcloud-h-')).toBe(true);
    // The pair is part of the hash: the same queue in another environment is another queue.
    expect(queueNames('stage', `${long}a`).queue).not.toBe(a.queue);
  });

  test('no two pairs share a queue or dead-letter name', () => {
    const pairs: [string, string][] = [];
    for (const namespace of ['a', 'a-b', 'a__b', 'a.b', 'prod']) {
      for (const queue of [
        'b-c',
        'c',
        'b__c',
        'a.b',
        'a_2eb',
        'a-b',
        'dlq',
        'x__dlq',
        'q'.repeat(90),
      ]) {
        pairs.push([namespace, queue]);
      }
    }
    const seen = new Map<string, string>();
    for (const [namespace, queue] of pairs) {
      const names = queueNames(namespace, queue);
      for (const name of [names.queue, names.deadLetter]) {
        const owner = `${namespace}/${queue}`;
        expect(seen.get(name) ?? owner).toBe(owner);
        seen.set(name, owner);
      }
    }
  });

  test('a queue literally named like a dead-letter suffix is still its own queue', () => {
    // `x__dlq` as a queue name encodes to `x_5f_5fdlq`: it cannot be mistaken for x's dead letters.
    expect(queueNames('prod', 'x__dlq').queue).not.toBe(queueNames('prod', 'x').deadLetter);
  });

  test('an empty namespace or queue is a configuration error', () => {
    expect(() => queueNames('', 'q')).toThrow(TransportError);
    expect(() => queueNames('prod', '')).toThrow(TransportError);
  });
});

describe('queueOfName', () => {
  test('reads a plain queue and dead-letter queue name back', () => {
    expect(queueOfName(queueNames('prod', 'a.b').queue)).toEqual({
      namespace: 'prod',
      queue: 'a.b',
      deadLetter: false,
    });
    expect(queueOfName(queueNames('prod', 'a.b').deadLetter)).toEqual({
      namespace: 'prod',
      queue: 'a.b',
      deadLetter: true,
    });
  });

  test('is null for a hashed name, a foreign name and a malformed one', () => {
    expect(queueOfName(queueNames('prod', 'q'.repeat(200)).queue)).toBeNull();
    expect(queueOfName('somebody-elses-queue')).toBeNull();
    expect(queueOfName('qcloud-no-separator')).toBeNull();
    expect(queueOfName('qcloud-prod__bad name')).toBeNull();
  });
});
