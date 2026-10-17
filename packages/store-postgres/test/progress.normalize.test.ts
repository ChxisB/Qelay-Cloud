import { describe, expect, test } from 'bun:test';
import { normalizeProgress } from '../src/store/progress';

describe('normalizeProgress: what a progress update is stored as', () => {
  test('a number is kept, clamped to 0..100, and NaN is 0', () => {
    expect(normalizeProgress(42)).toEqual({ progress: 42 });
    expect(normalizeProgress(0)).toEqual({ progress: 0 });
    expect(normalizeProgress(150)).toEqual({ progress: 100 });
    expect(normalizeProgress(-5)).toEqual({ progress: 0 });
    expect(normalizeProgress(Number.NaN)).toEqual({ progress: 0 });
    expect(normalizeProgress(Number.POSITIVE_INFINITY)).toEqual({ progress: 100 });
    expect(normalizeProgress(12.5)).toEqual({ progress: 12.5 });
  });

  test('an object is 0 with its JSON as the message', () => {
    expect(normalizeProgress({ step: 'download', done: 3 })).toEqual({
      progress: 0,
      message: '{"step":"download","done":3}',
    });
    expect(normalizeProgress([1, 2])).toEqual({ progress: 0, message: '[1,2]' });
  });

  test('an object JSON cannot encode has no message, and never throws', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(normalizeProgress(cyclic)).toEqual({ progress: 0 });
    expect(normalizeProgress({ big: 10n })).toEqual({ progress: 0 });
  });

  test('a numeric string, a boolean and null are their number', () => {
    expect(normalizeProgress('50')).toEqual({ progress: 50 });
    expect(normalizeProgress('')).toEqual({ progress: 0 });
    expect(normalizeProgress(true)).toEqual({ progress: 1 });
    expect(normalizeProgress(false)).toEqual({ progress: 0 });
    expect(normalizeProgress(null)).toEqual({ progress: 0 });
  });

  test('any other string is 0 with the text as the message, unless a message is given', () => {
    expect(normalizeProgress('downloading')).toEqual({ progress: 0, message: 'downloading' });
    expect(normalizeProgress('downloading', 'step 2')).toEqual({ progress: 0, message: 'step 2' });
    expect(normalizeProgress(60, 'sixty')).toEqual({ progress: 60, message: 'sixty' });
  });

  test('anything else is 0', () => {
    expect(normalizeProgress(undefined)).toEqual({ progress: 0 });
    expect(normalizeProgress(Symbol('x'))).toEqual({ progress: 0 });
    expect(normalizeProgress(() => 1)).toEqual({ progress: 0 });
  });

  test('a message with a NUL or a lone surrogate is dropped, so the column accepts it', () => {
    expect(normalizeProgress(10, 'a\0b')).toEqual({ progress: 10 });
    expect(normalizeProgress('x\uD800y')).toEqual({ progress: 0 });
    // JSON escapes both, so an object's message is always storable.
    expect(normalizeProgress({ k: 'a\0b' })).toEqual({ progress: 0, message: '{"k":"a\\u0000b"}' });
  });
});
