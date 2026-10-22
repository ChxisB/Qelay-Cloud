import { describe, expect, test } from 'bun:test';
import {
  ago,
  claimableLabel,
  doorbellVerdict,
  figure,
  freshnessLabel,
  span,
  stripTone,
  tickTone,
  verdictTone,
  worse,
} from '../src/lib/ops/health';
import { deployment, queue } from './ops.helpers';

describe('unknown is words, never zero', () => {
  test('a count that was not read is "unknown" and a read zero is "0"', () => {
    expect(figure(null)).toBe('unknown');
    expect(figure(undefined)).toBe('unknown');
    expect(figure(0)).toBe('0');
    expect(figure(12_345)).toBe('12,345');
  });

  test('a duration that was not read is "unknown"', () => {
    expect(span(null)).toBe('unknown');
    expect(span(0)).not.toBe('unknown');
    expect(ago(null)).toBe('unknown');
    expect(ago(Number.NaN)).toBe('unknown');
  });

  test.each([
    [0, '0s ago'],
    [12_000, '12s ago'],
    [59_999, '59s ago'],
    [60_000, '1m ago'],
    [3_599_000, '59m ago'],
    [3_600_000, '1h ago'],
    [90_000_000, '1d ago'],
    [-5_000, '0s ago'],
  ])('%i ms reads as %s', (ms, words) => {
    expect(ago(ms)).toBe(words);
  });
});

describe('durations on the ops pages', () => {
  test.each([
    [850, '850ms'],
    [1_500, '1s'],
    [12_000, '12s'],
    [60_000, '1m'],
    [90_000, '1m 30s'],
    [300_000, '5m'],
    [7_500_000, '2h 5m'],
    [7_200_000, '2h'],
    [98_000_000, '1d 3h'],
  ])('%i ms reads as %s', (ms, words) => {
    expect(span(ms)).toBe(words);
  });
});

describe('a broker figure says how old it is', () => {
  test('a metric reading is "as of" with the lag the metric has by design', () => {
    expect(freshnessLabel(queue('q'))).toBe('45s ago, up to 5m behind · cloud-monitoring');
  });

  test('an exact reading carries no lag', () => {
    const exact = queue('q', {
      freshness: { observedAt: 1, ageMs: 0, maxStalenessMs: 0, source: 'memory' },
    });
    expect(freshnessLabel(exact)).toBe('0s ago · memory');
  });

  test('a reading that could not be made says so instead of an age', () => {
    const none = queue('q', {
      freshness: { observedAt: null, ageMs: null, maxStalenessMs: 0, source: 'unavailable' },
    });
    expect(freshnessLabel(none)).toBe('not read');
  });
});

describe('the Dashboard indicator', () => {
  test.each([
    ['ok', 'green'],
    ['late', 'amber'],
    ['stale', 'red'],
    ['never', 'red'],
    ['unknown', 'zinc'],
  ] as const)('a tick that is %s is %s', (state, tone) => {
    expect(tickTone(state)).toBe(tone);
    expect(stripTone(deployment({ tick: { ...deployment().tick, state } }))).toBe(tone);
  });

  test('the worse of two tones wins and unknown outranks healthy', () => {
    expect(worse('green', 'zinc')).toBe('zinc');
    expect(worse('zinc', 'amber')).toBe('amber');
    expect(worse('red', 'amber')).toBe('red');
  });

  test('a database that failed is red whatever the tick says', () => {
    expect(stripTone(deployment({ database: { state: 'failed', latencyMs: null } }))).toBe('red');
  });

  test('a database that was not probed is not "healthy"', () => {
    expect(stripTone(deployment({ database: { state: 'unknown', latencyMs: null } }))).toBe('zinc');
  });

  test.each([
    ['warning', 'amber'],
    ['critical', 'red'],
  ] as const)('overdue doorbells at %s severity colour it %s', (severity, tone) => {
    const body = deployment({
      warnings: [{ code: 'doorbells_overdue', severity, message: 'overdue' }],
    });
    expect(stripTone(body)).toBe(tone);
  });

  test('a configuration warning does not colour a healthy path', () => {
    const body = deployment({
      devToken: true,
      warnings: [{ code: 'dev_token_enabled', severity: 'warning', message: 'dev token' }],
    });
    expect(stripTone(body)).toBe('green');
  });

  test('a broker that cannot be reached is amber, not red: jobs are safe in the database', () => {
    expect(stripTone(deployment({ transport: { name: 'x', state: 'failed' } }))).toBe('amber');
  });
});

describe('what a queue row says', () => {
  test('a paused queue is held on purpose, not behind', () => {
    const verdict = doorbellVerdict(
      queue('q', {
        store: { paused: true, claimable: 50, notRung: 50, oldestNotRungAgeMs: 900_000 },
      }),
      60_000
    );
    expect(verdict.kind).toBe('held');
  });

  test('claimable jobs unrung for longer than the threshold say maintenance is behind', () => {
    const verdict = doorbellVerdict(
      queue('q', { store: { claimable: 9, notRung: 9, oldestNotRungAgeMs: 61_000 } }),
      60_000
    );
    expect(verdict.kind).toBe('tick-behind');
    expect(verdict.text).toContain('maintenance is behind');
    expect(verdictTone(verdict)).toBe('amber');
  });

  test('unrung jobs inside the threshold are only waiting for the next maintenance run', () => {
    const verdict = doorbellVerdict(
      queue('q', { store: { claimable: 2, notRung: 2, oldestNotRungAgeMs: 3_000 } }),
      60_000
    );
    expect(verdict.kind).toBe('ok');
    expect(verdict.text).toContain('next maintenance run');
  });

  test('failed notifications outrank everything but a pause, and the jobs are said to be safe', () => {
    const verdict = doorbellVerdict(queue('q', { deadLetterDepth: 7 }), 60_000);
    expect(verdict.kind).toBe('poison');
    expect(verdict.text).toContain('7 failed notifications');
    expect(verdict.text).toContain('jobs stay in the database');
    expect(verdictTone(verdict)).toBe('red');
  });

  test('a backlog of re-ring-due bells is normal and is not an alarm', () => {
    const verdict = doorbellVerdict(
      queue('q', { store: { claimable: 900, reRingDue: 880 }, doorbellDepth: 900 }),
      60_000
    );
    expect(verdict.kind).toBe('backlog');
    expect(verdict.text).toContain('Normal');
    expect(verdictTone(verdict)).toBe('zinc');
  });

  test('a broker that answered nothing is unknown, not "nothing waiting"', () => {
    const verdict = doorbellVerdict(
      queue('q', { doorbellDepth: null, deadLetterDepth: null }),
      60_000
    );
    expect(verdict.kind).toBe('unknown');
  });

  test('a quiet queue says nothing is waiting', () => {
    expect(doorbellVerdict(queue('q'), 60_000).kind).toBe('ok');
  });

  test('a count stopped at its cap reads as "or more"', () => {
    expect(claimableLabel(queue('q', { store: { claimable: 1000, capped: true } }).store)).toBe(
      '1,000+'
    );
    expect(claimableLabel(queue('q', { store: { claimable: 3 } }).store)).toBe('3');
  });
});
