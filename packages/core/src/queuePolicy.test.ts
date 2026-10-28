import { describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from './errors';
import { validateQueuePolicy } from './queuePolicy';

function refused(policy: unknown): UnsupportedOptionError {
  try {
    validateQueuePolicy(policy);
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    return error as UnsupportedOptionError;
  }
  throw new Error('expected UnsupportedOptionError');
}

describe('validateQueuePolicy', () => {
  test('accepts the three settings and writes a backoff as an object', () => {
    expect(
      validateQueuePolicy({
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000, maxDelay: 600_000 },
        timeout: 30_000,
      })
    ).toEqual({
      attempts: 5,
      backoff: { type: 'exponential', delay: 10_000, maxDelay: 600_000 },
      timeout: 30_000,
    });
    expect(validateQueuePolicy({ backoff: 2000 })).toEqual({
      backoff: { type: 'fixed', delay: 2000 },
    });
  });

  test('an empty policy is valid and means none', () => {
    expect(validateQueuePolicy({})).toEqual({});
    expect(validateQueuePolicy({ attempts: undefined })).toEqual({});
  });

  test('each refusal names the field', () => {
    for (const [policy, option] of [
      [null, 'policy'],
      [[1], 'policy'],
      [{ attempts: 0 }, 'attempts'],
      [{ attempts: 1.5 }, 'attempts'],
      [{ attempts: null }, 'attempts'],
      [{ timeout: 0 }, 'timeout'],
      [{ backoff: { type: 'linear', delay: 1 } }, 'backoff.type'],
      [{ backoff: { type: 'fixed', delay: -1 } }, 'backoff.delay'],
      [{ backoff: { type: 'fixed', delay: 1, maxDelay: 86_400_001 } }, 'backoff.maxDelay'],
      [{ delay: 1000 }, 'delay'],
      [{ priority: 1 }, 'priority'],
    ] as const) {
      expect(refused(policy).option).toBe(option);
    }
  });

  test('a backoff key that is not stored is refused, jitter included', () => {
    const error = refused({ backoff: { type: 'fixed', delay: 1, jitter: true } });
    expect(error.option).toBe('backoff.jitter');
    expect(error.message).toContain('whole service');
  });
});
