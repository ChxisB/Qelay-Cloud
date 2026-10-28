import { describe, expect, test } from 'bun:test';
import {
  policyDraft,
  policyPayload,
  spell,
  windowDraft,
  windowPayload,
} from '../src/pages/control/queue/queueSettingModel';

describe('spell', () => {
  test('uses the largest unit that reads plainly', () => {
    expect(spell(500)).toBe('500 milliseconds');
    expect(spell(1000)).toBe('1 second');
    expect(spell(30_000)).toBe('30 seconds');
    expect(spell(90 * 60_000)).toBe('1.5 hours');
    expect(spell(4 * 3_600_000)).toBe('4 hours');
    expect(spell(2 * 86_400_000)).toBe('2 days');
  });
});

describe('the retry policy form', () => {
  test('a policy reads back into the same payload', () => {
    const policy = {
      attempts: 5,
      backoff: { type: 'exponential' as const, delay: 1500, maxDelay: 60_000 },
      timeout: 30_000,
    };
    expect(policyPayload(policyDraft(policy))).toEqual({ ok: true, value: policy });
  });

  test('every field blank is the empty policy, which removes it', () => {
    expect(policyPayload(policyDraft(null))).toEqual({ ok: true, value: {} });
  });

  test('a fixed backoff leaves the longest delay out', () => {
    const draft = { ...policyDraft(null), backoff: 'fixed' as const, delay: '2', maxDelay: '9' };
    expect(policyPayload(draft)).toEqual({
      ok: true,
      value: { backoff: { type: 'fixed', delay: 2000 } },
    });
  });

  test.each([
    [{ attempts: '0' }, 'Attempts'],
    [{ attempts: '2.5' }, 'Attempts'],
    [{ backoff: 'fixed' as const, delay: '' }, 'retry delay'],
    [{ backoff: 'fixed' as const, delay: '90000' }, 'retry delay'],
    [{ backoff: 'exponential' as const, delay: '1', maxDelay: '-1' }, 'longest delay'],
    [{ delay: '3' }, 'Choose how retries are spaced'],
    [{ timeout: '0' }, 'time limit'],
  ])('refuses %j', (patch, message) => {
    const result = policyPayload({ ...policyDraft(null), ...patch });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain(message);
  });
});

describe('the run window form', () => {
  const window = {
    cron: '0 0 * * *',
    durationMs: 4 * 3_600_000,
    timezone: 'Europe/London',
    open: false,
    opensAt: 1,
    closesAt: 2,
  };

  test('a window reads back into the same payload', () => {
    expect(windowPayload(windowDraft(window))).toEqual({
      ok: true,
      value: { cron: '0 0 * * *', durationMs: 14_400_000, timezone: 'Europe/London' },
    });
  });

  test('a blank zone is left out, so the server uses UTC', () => {
    const draft = { cron: ' @daily ', hours: '0.5', timezone: ' ' };
    expect(windowPayload(draft)).toEqual({
      ok: true,
      value: { cron: '@daily', durationMs: 1_800_000 },
    });
  });

  test.each([
    [{ cron: '' }, 'when the window opens'],
    [{ hours: '' }, '1 minute to 7 days'],
    [{ hours: '0.001' }, '1 minute to 7 days'],
    [{ hours: '169' }, '1 minute to 7 days'],
  ])('refuses %j', (patch, message) => {
    const result = windowPayload({ ...windowDraft(window), ...patch });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain(message);
  });
});
