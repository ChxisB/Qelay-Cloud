import { describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from './errors';
import type { JobOptions } from './jobs';
import { validateJobOptions } from './options';

function refused(options: unknown): UnsupportedOptionError {
  try {
    validateJobOptions(options as JobOptions);
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    return error as UnsupportedOptionError;
  }
  throw new Error('expected UnsupportedOptionError');
}

describe('validateJobOptions', () => {
  test('accepts the supported subset and returns it unchanged', () => {
    const options: JobOptions = {
      priority: 5,
      lifo: true,
      delay: 1000,
      attempts: 3,
      backoff: { type: 'exponential', delay: 500, maxDelay: 60_000 },
      timeout: 30_000,
      stallTimeout: 15_000,
      jobId: 'order-1',
      deduplication: { id: 'k', ttl: 1000, extend: true },
      group: { id: 'tenant-a', maxSize: 10, priority: 2 },
      removeOnComplete: true,
      removeOnFail: false,
    };
    expect(validateJobOptions(options)).toBe(options);
    expect(validateJobOptions()).toEqual({});
  });

  test('names an upstream option that v1.0.0 does not take', () => {
    for (const key of ['repeat', 'debounce', 'keepLogs', 'durable']) {
      const error = refused({ [key]: 1 });
      expect(error.option).toBe(key);
      expect(error.code).toBe('UNSUPPORTED_OPTION');
      expect(error.message).toContain('not supported in v1.0.0');
    }
  });

  test('sends the options of a flow to FlowProducer, since a plain add cannot honour them', () => {
    for (const key of [
      'parent',
      'failParentOnFailure',
      'removeDependencyOnFailure',
      'continueParentOnFailure',
      'ignoreDependencyOnFailure',
    ]) {
      const error = refused({ [key]: true });
      expect(error.option).toBe(key);
      expect(error.code).toBe('UNSUPPORTED_OPTION');
      expect(error.message).toContain('FlowProducer');
    }
  });

  test('refuses an unknown option rather than ignoring it', () => {
    expect(refused({ prority: 1 }).message).toContain('is unknown');
  });

  test('refuses age and count retention, which upstream does not support either', () => {
    expect(refused({ removeOnComplete: 100 }).option).toBe('removeOnComplete');
    expect(refused({ removeOnFail: { age: 5 } }).option).toBe('removeOnFail');
  });

  test('refuses invalid values', () => {
    expect(refused({ priority: -1 }).option).toBe('priority');
    expect(refused({ priority: 1.5 }).option).toBe('priority');
    expect(refused({ attempts: 0 }).option).toBe('attempts');
    expect(refused({ timeout: 0 }).option).toBe('timeout');
    expect(refused({ delay: Number.NaN }).option).toBe('delay');
    expect(refused({ delay: 366 * 24 * 3600 * 1000 }).option).toBe('delay');
    expect(refused({ jobId: '' }).option).toBe('jobId');
    expect(refused({ backoff: { type: 'linear', delay: 1 } }).option).toBe('backoff.type');
    expect(refused({ backoff: { type: 'fixed', delay: 1, maxDelay: 86_400_001 } }).option).toBe(
      'backoff.maxDelay'
    );
    expect(refused({ deduplication: { id: '' } }).option).toBe('deduplication.id');
    expect(refused({ group: { id: 'g', priority: 2_097_152 } }).option).toBe('group.priority');
  });

  test('a negative delay is accepted, as upstream reads it as 0', () => {
    expect(() => validateJobOptions({ delay: -5 })).not.toThrow();
  });
});
