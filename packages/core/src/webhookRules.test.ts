import { describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from './errors';
import {
  dedupeValues,
  MAX_DEDUPE_WINDOW_MS,
  MAX_WEBHOOK_DELAY_MS,
  validateDedupe,
  validateDelay,
  validateDescription,
  validateName,
  WEBHOOK_HOLD_REASON,
  webhookPausedBy,
  WEBHOOK_DESCRIPTION_CHARS,
  WEBHOOK_NAME_CHARS,
} from './webhookRules';

const refused = (run: () => unknown, option: string) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    expect((error as UnsupportedOptionError).option).toBe(option);
    return;
  }
  throw new Error(`expected ${option} to be refused`);
};

describe('name and description', () => {
  test('are trimmed, and null or blank clears them', () => {
    expect(validateName('  Orders to billing ')).toBe('Orders to billing');
    expect(validateName(null)).toBeNull();
    expect(validateName('   ')).toBeNull();
    expect(validateDescription('Sends failed orders\nto billing.')).toBe(
      'Sends failed orders\nto billing.'
    );
    expect(validateDescription(undefined)).toBeNull();
  });

  test('are refused when not text, too long or holding control characters', () => {
    refused(() => validateName(7), 'name');
    refused(() => validateName('x'.repeat(WEBHOOK_NAME_CHARS + 1)), 'name');
    refused(() => validateName('a\u0000b'), 'name');
    refused(() => validateName('a\nb'), 'name');
    refused(() => validateDescription('x'.repeat(WEBHOOK_DESCRIPTION_CHARS + 1)), 'description');
    refused(() => validateDescription('a\u0007b'), 'description');
    expect(validateName('x'.repeat(WEBHOOK_NAME_CHARS))).toHaveLength(WEBHOOK_NAME_CHARS);
  });
});

describe('delay', () => {
  test('is a whole number of milliseconds from one second to one hour, or null', () => {
    expect(validateDelay(1_000)).toBe(1_000);
    expect(validateDelay(MAX_WEBHOOK_DELAY_MS)).toBe(MAX_WEBHOOK_DELAY_MS);
    expect(validateDelay(null)).toBeNull();
    expect(validateDelay(undefined)).toBeNull();
    for (const bad of [0, 999, MAX_WEBHOOK_DELAY_MS + 1, 1.5, '5000', Number.NaN]) {
      refused(() => validateDelay(bad), 'delayMs');
    }
  });
});

describe('dedupe', () => {
  test('keeps the window and the paths sorted, once each', () => {
    expect(
      validateDedupe({ windowMs: 60_000, fields: ['body.error', 'body.queue', 'body.error'] })
    ).toEqual({ windowMs: 60_000, fields: ['body.error', 'body.queue'] });
    expect(validateDedupe(null)).toBeNull();
  });

  test('refuses what it does not know, by name', () => {
    refused(() => validateDedupe('yes'), 'dedupe');
    refused(() => validateDedupe({ windowMs: 60_000 }), 'dedupe');
    refused(() => validateDedupe({ windowMs: 60_000, fields: [] }), 'dedupe');
    refused(() => validateDedupe({ windowMs: 60_000, fields: ['queue'] }), 'dedupe');
    refused(() => validateDedupe({ windowMs: 60_000, fields: ['body.'] }), 'dedupe');
    refused(
      () =>
        validateDedupe({
          windowMs: 60_000,
          fields: ['body.a', 'body.b', 'body.c', 'body.d', 'body.e', 'body.f'],
        }),
      'dedupe'
    );
    refused(() => validateDedupe({ windowMs: 60_000, fields: ['body.id'], extra: 1 }), 'dedupe');
    refused(() => validateDedupe({ windowMs: 999, fields: ['body.id'] }), 'dedupe');
    refused(
      () => validateDedupe({ windowMs: MAX_DEDUPE_WINDOW_MS + 1, fields: ['body.id'] }),
      'dedupe'
    );
  });

  test('values are the same for equal requests and differ when one chosen path does', () => {
    const a = { body: { queue: 'q', id: 'j1', error: 'boom' } };
    const b = { body: { queue: 'q', id: 'j2', error: 'boom' } };
    expect(dedupeValues(['body.queue', 'body.error'], a)).toBe(
      dedupeValues(['body.queue', 'body.error'], b)
    );
    expect(dedupeValues(['body.id'], a)).not.toBe(dedupeValues(['body.id'], b));
    // A missing value is not the text "null".
    expect(dedupeValues(['body.error'], { body: {} })).not.toBe(
      dedupeValues(['body.error'], { body: { error: 'null' } })
    );
  });

  test('who paused a route: an operator hold, the failure streak, or nobody', () => {
    const off = (disabledReason: string | null) => ({ enabled: false, disabledReason });
    expect(webhookPausedBy(off(WEBHOOK_HOLD_REASON))).toBe('operator');
    expect(webhookPausedBy(off('5 failed deliveries in a row'))).toBe('failures');
    expect(webhookPausedBy(off(null))).toBeNull();
    expect(webhookPausedBy({ enabled: true, disabledReason: WEBHOOK_HOLD_REASON })).toBeNull();
  });
});
