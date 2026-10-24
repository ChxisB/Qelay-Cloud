import { describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from './errors';
import { MAX_FILTER_DEPTH, matchesFilter, validateFilter } from './webhookFilter';

/** A request document (DESIGN.md D14). */
const failed = {
  method: 'POST',
  headers: { 'x-event': 'order.failed' },
  query: {},
  body: { queue: 'emails', state: 'failed', error: 'timeout: upstream', at: 5_000 },
};
const pushed = {
  method: 'POST',
  headers: { 'x-event': 'order.pushed' },
  query: {},
  body: { queue: 'emails', at: 6_000 },
};

const passes = (filter: unknown, document: Record<string, unknown>): boolean =>
  matchesFilter(validateFilter(filter), document);

describe('webhook filter', () => {
  test('a path with a plain value is $eq, and all terms must hold', () => {
    expect(passes({ 'body.queue': 'emails' }, failed)).toBe(true);
    expect(passes({ 'body.queue': 'emails', 'body.state': 'completed' }, failed)).toBe(false);
  });

  test('operators: $in, $startsWith, comparisons and $exist', () => {
    expect(passes({ 'headers.x-event': { $in: ['order.failed', 'order.done'] } }, failed)).toBe(
      true
    );
    expect(passes({ 'body.error': { $startsWith: 'timeout' } }, failed)).toBe(true);
    expect(passes({ 'body.at': { $gt: 4_000, $lte: 5_000 } }, failed)).toBe(true);
    expect(passes({ 'body.at': { $lt: 5_000 } }, failed)).toBe(false);
    expect(passes({ 'body.error': { $exist: true } }, failed)).toBe(true);
    expect(passes({ 'body.error': { $exist: true } }, pushed)).toBe(false);
    expect(passes({ 'body.error': { $exist: false } }, pushed)).toBe(true);
  });

  test('a path the request has no value for matches nothing but $exist: false', () => {
    expect(passes({ 'body.error': 'x' }, pushed)).toBe(false);
    expect(passes({ 'body.progress': { $gt: 0 } }, pushed)).toBe(false);
    expect(passes({ 'body.error': { $startsWith: 't' } }, pushed)).toBe(false);
  });

  test('$and, $or and $not combine filters', () => {
    const filter = {
      $or: [
        { 'headers.x-event': 'order.failed', 'body.error': { $startsWith: 'timeout' } },
        { 'body.state': 'completed' },
      ],
      $not: { 'body.queue': 'internal' },
    };
    expect(passes(filter, failed)).toBe(true);
    expect(passes(filter, pushed)).toBe(false);
  });

  test.each([
    ['empty', {}],
    ['a list', []],
    ['an unknown root', { data: 'x' }],
    ['a bare name that is no root', { queue: 'emails' }],
    ['an unknown operator', { 'body.queue': { $regex: '.*' } }],
    ['text for a comparison', { 'body.at': { $gt: 'a' } }],
    ['an empty $startsWith', { 'body.queue': { $startsWith: '' } }],
    ['a non-boolean $exist', { 'body.error': { $exist: 1 } }],
    ['an empty $in', { 'body.queue': { $in: [] } }],
    ['an empty $or', { $or: [] }],
    ['a long string', { 'body.queue': 'x'.repeat(257) }],
    ['an operator-less object', { 'body.queue': {} }],
  ])('refuses %s, naming the filter option', (_name, filter) => {
    expect(() => validateFilter(filter)).toThrow(UnsupportedOptionError);
  });

  test('refuses a filter that nests too deep or has too many terms', () => {
    let deep: Record<string, unknown> = { 'body.queue': 'a' };
    for (let i = 0; i < MAX_FILTER_DEPTH; i += 1) deep = { $not: deep };
    expect(() => validateFilter(deep)).toThrow('deeper');
    const wide = {
      $and: Array.from({ length: 20 }, () => ({
        $or: [{ 'body.queue': 'a' }, { 'body.queue': 'b' }],
      })),
    };
    expect(() => validateFilter(wide)).toThrow('terms');
  });
});
