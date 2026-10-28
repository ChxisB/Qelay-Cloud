import { describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from './errors';
import { MAX_WINDOW_MS, MIN_WINDOW_MS, validateRunWindow } from './queueWindow';

function refused(value: unknown): UnsupportedOptionError {
  try {
    validateRunWindow(value);
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    return error as UnsupportedOptionError;
  }
  throw new Error('expected UnsupportedOptionError');
}

describe('validateRunWindow', () => {
  test('trims the cron and defaults the zone to UTC', () => {
    expect(validateRunWindow({ cron: ' 0 0 * * * ', durationMs: 3_600_000 })).toEqual({
      cron: '0 0 * * *',
      durationMs: 3_600_000,
      timezone: 'UTC',
    });
    expect(
      validateRunWindow({ cron: '@daily', durationMs: MIN_WINDOW_MS, timezone: 'Europe/London' })
    ).toEqual({ cron: '@daily', durationMs: MIN_WINDOW_MS, timezone: 'Europe/London' });
  });

  test('each refusal names the field', () => {
    for (const [value, option] of [
      [null, 'runWindow'],
      [[], 'runWindow'],
      [{ durationMs: 3_600_000 }, 'runWindow'],
      [{ cron: '@daily' }, 'durationMs'],
      [{ cron: '@daily', durationMs: MIN_WINDOW_MS - 1 }, 'durationMs'],
      [{ cron: '@daily', durationMs: MAX_WINDOW_MS + 1 }, 'durationMs'],
      [{ cron: '@daily', durationMs: MIN_WINDOW_MS + 0.5 }, 'durationMs'],
      [{ cron: '@daily', durationMs: '3600000' }, 'durationMs'],
      [{ cron: '@daily', durationMs: MIN_WINDOW_MS, timezone: 'Mars/Base' }, 'runWindow'],
      [{ cron: '@daily', durationMs: MIN_WINDOW_MS, extra: 1 }, 'runWindow'],
    ] as const) {
      expect(refused(value).option).toBe(option);
    }
  });
});
