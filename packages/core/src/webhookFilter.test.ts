import { describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from './errors';
import type { WebhookSubject } from './webhookFilter';
import { MAX_FILTER_DEPTH, matchesFilter, validateFilter } from './webhookFilter';

const failed: WebhookSubject = {
  event: 'job.failed',
  queue: 'emails',
  jobId: 'j1',
  occurredAt: 5_000,
  state: 'failed',
  error: 'timeout: upstream',
};
const pushed: WebhookSubject = {
  event: 'job.pushed',
  queue: 'emails',
  jobId: 'j2',
  occurredAt: 6_000,
};

const passes = (filter: unknown, subject: WebhookSubject): boolean =>
  matchesFilter(validateFilter(filter), subject);

describe('webhook filter', () => {
  test('a field with a plain value is $eq, and all terms must hold', () => {
    expect(passes({ queue: 'emails' }, failed)).toBe(true);
    expect(passes({ queue: 'emails', state: 'completed' }, failed)).toBe(false);
  });

  test('operators: $in, $startsWith, comparisons and $exist', () => {
    expect(passes({ event: { $in: ['job.failed', 'job.completed'] } }, failed)).toBe(true);
    expect(passes({ error: { $startsWith: 'timeout' } }, failed)).toBe(true);
    expect(passes({ occurredAt: { $gt: 4_000, $lte: 5_000 } }, failed)).toBe(true);
    expect(passes({ occurredAt: { $lt: 5_000 } }, failed)).toBe(false);
    expect(passes({ error: { $exist: true } }, failed)).toBe(true);
    expect(passes({ error: { $exist: true } }, pushed)).toBe(false);
    expect(passes({ error: { $exist: false } }, pushed)).toBe(true);
  });

  test('a field the event has no value for matches nothing but $exist: false', () => {
    expect(passes({ error: 'x' }, pushed)).toBe(false);
    expect(passes({ progress: { $gt: 0 } }, pushed)).toBe(false);
    expect(passes({ error: { $startsWith: 't' } }, pushed)).toBe(false);
  });

  test('$and, $or and $not combine filters', () => {
    const filter = {
      $or: [{ event: 'job.failed', error: { $startsWith: 'timeout' } }, { state: 'completed' }],
      $not: { queue: 'internal' },
    };
    expect(passes(filter, failed)).toBe(true);
    expect(passes(filter, pushed)).toBe(false);
  });

  test.each([
    ['empty', {}],
    ['a list', []],
    ['an unknown field', { data: 'x' }],
    ['an unknown operator', { queue: { $regex: '.*' } }],
    ['a number for a text field', { queue: 5 }],
    ['text for a number field', { progress: 'a' }],
    ['$gt on text', { queue: { $gt: 1 } }],
    ['an empty $startsWith', { queue: { $startsWith: '' } }],
    ['a non-boolean $exist', { error: { $exist: 1 } }],
    ['an empty $in', { queue: { $in: [] } }],
    ['an empty $or', { $or: [] }],
    ['a long string', { queue: 'x'.repeat(257) }],
    ['an operator-less object', { queue: {} }],
  ])('refuses %s, naming the filter option', (_name, filter) => {
    expect(() => validateFilter(filter)).toThrow(UnsupportedOptionError);
  });

  test('refuses a filter that nests too deep or has too many terms', () => {
    let deep: Record<string, unknown> = { queue: 'a' };
    for (let i = 0; i < MAX_FILTER_DEPTH; i += 1) deep = { $not: deep };
    expect(() => validateFilter(deep)).toThrow('deeper');
    const wide = {
      $and: Array.from({ length: 20 }, () => ({ $or: [{ queue: 'a' }, { queue: 'b' }] })),
    };
    expect(() => validateFilter(wide)).toThrow('terms');
  });
});
