import { describe, expect, test } from 'bun:test';
import type { DeploymentResponse } from '../src';
import {
  CONNECTIONS_CRITICAL_RATIO,
  CONNECTIONS_WARN_RATIO,
  deploymentWarnings,
} from '../src/ops/warnings';

type Parts = Parameters<typeof deploymentWarnings>[0];

/** Everything healthy, so each test changes the one reading it is about. */
const healthy = (): Parts => ({
  devToken: false,
  schema: { current: 5, expected: 5, state: 'current' },
  database: { state: 'ok', latencyMs: 2 },
  transport: { name: 'gcp-pubsub', state: 'ok' },
  connections: { inUse: 10, maxConnections: 100, needed: 20, mode: 'direct' },
  tick: {
    state: 'ok',
    lastSuccessAt: 1_000,
    lastFailureAt: null,
    ageMs: 1_000,
    lateAfterMs: 60_000,
    staleAfterMs: 300_000,
  },
  doorbells: { notRung: 0, oldestNotRungAgeMs: null, queuesScanned: 3, partial: false },
});

const warn = (change: (parts: Parts) => Partial<Parts>) => {
  const parts = healthy();
  return deploymentWarnings({ ...parts, ...change(parts) });
};
const only = (warnings: ReturnType<typeof deploymentWarnings>, code: string) =>
  warnings.filter((warning) => warning.code === code);

describe('deploymentWarnings', () => {
  test('a healthy deployment has none', () => {
    expect(deploymentWarnings(healthy())).toEqual([]);
  });

  test('every reading the page has is unknown at once: only what not knowing makes worth saying', () => {
    const parts = healthy();
    const warnings = deploymentWarnings({
      devToken: false,
      schema: { current: null, expected: 5, state: 'unknown' },
      database: { state: 'unknown', latencyMs: null },
      transport: { name: 'gcp-pubsub', state: 'unknown' },
      connections: { inUse: null, maxConnections: null, needed: null, mode: null },
      tick: { ...parts.tick, state: 'unknown', lastSuccessAt: null, ageMs: null },
      doorbells: { notRung: null, oldestNotRungAgeMs: null, queuesScanned: null, partial: false },
    });
    // Not knowing the tick is worth saying; not knowing a count never turns into a zero or a healthy.
    expect(warnings.map((warning) => warning.code)).toEqual(['tick_unknown']);
  });

  test.each([
    [
      'database_unreachable',
      'critical',
      (): Partial<Parts> => ({ database: { state: 'failed', latencyMs: null } }),
    ],
    [
      'transport_unreachable',
      'critical',
      (): Partial<Parts> => ({ transport: { name: 'sqs', state: 'failed' } }),
    ],
    [
      'schema_ahead',
      'warning',
      (): Partial<Parts> => ({ schema: { current: 6, expected: 5, state: 'ahead' } }),
    ],
    [
      'schema_behind',
      'critical',
      (): Partial<Parts> => ({ schema: { current: 4, expected: 5, state: 'behind' } }),
    ],
    ['dev_token_enabled', 'warning', (): Partial<Parts> => ({ devToken: true })],
  ] as const)('%s is a %s', (code, severity, change) => {
    expect(only(warn(change), code)).toEqual([{ code, severity, message: expect.any(String) }]);
  });

  describe('the tick', () => {
    const tick = (state: DeploymentResponse['tick']['state']) => (parts: Parts) => ({
      tick: { ...parts.tick, state },
    });

    test.each([
      ['never', 'tick_never_ran', 'critical'],
      ['stale', 'tick_stale', 'critical'],
      ['late', 'tick_late', 'warning'],
      ['unknown', 'tick_unknown', 'warning'],
    ] as const)('%s is %s (%s)', (state, code, severity) => {
      expect(warn(tick(state)).map(({ code: found, severity: level }) => [found, level])).toEqual([
        [code, severity],
      ]);
    });

    test('names the threshold it crossed in words', () => {
      const [late] = warn(tick('late'));
      const [stale] = warn(tick('stale'));
      expect(late!.message).toContain('1 minute');
      expect(stale!.message).toContain('5 minutes');
    });
  });

  describe('connections', () => {
    const using = (inUse: number) => (parts: Parts) => ({
      connections: { ...parts.connections, inUse, maxConnections: 100 },
    });

    test('are fine below the warning ratio', () => {
      expect(warn(using(CONNECTIONS_WARN_RATIO * 100 - 1))).toEqual([]);
    });
    test('warn at the warning ratio', () => {
      expect(warn(using(CONNECTIONS_WARN_RATIO * 100)).map((w) => [w.code, w.severity])).toEqual([
        ['connections_high', 'warning'],
      ]);
    });
    test('are critical at the critical ratio', () => {
      expect(
        warn(using(CONNECTIONS_CRITICAL_RATIO * 100)).map((w) => [w.code, w.severity])
      ).toEqual([['connections_exhausted', 'critical']]);
    });
    test('a declared fleet that needs more than the cap is critical, whatever is in use now', () => {
      const warnings = warn((parts) => ({
        connections: { ...parts.connections, inUse: 1, needed: 101 },
      }));
      expect(warnings.map((w) => [w.code, w.severity])).toEqual([
        ['connection_budget_exceeded', 'critical'],
      ]);
      expect(warnings[0]!.message).toContain('101');
    });
    test('an unknown cap is never a warning', () => {
      expect(
        warn((parts) => ({
          connections: { ...parts.connections, inUse: 99, maxConnections: null },
        }))
      ).toEqual([]);
    });
  });

  describe('doorbells', () => {
    const waited = (oldestNotRungAgeMs: number | null) => (parts: Parts) => ({
      doorbells: { ...parts.doorbells, notRung: 4, oldestNotRungAgeMs },
    });

    test('a short wait is the tick being on time', () => {
      expect(warn(waited(59_999))).toEqual([]);
    });
    test('a wait as long as the late threshold says the tick is behind', () => {
      const [warning] = warn(waited(60_000));
      expect(warning).toMatchObject({ code: 'doorbells_overdue', severity: 'warning' });
      expect(warning!.message).toContain('the tick is behind');
    });
    test('a wait as long as the stale threshold is critical', () => {
      expect(warn(waited(300_000))[0]).toMatchObject({
        code: 'doorbells_overdue',
        severity: 'critical',
      });
    });
    test('no reading is no warning', () => {
      expect(warn(waited(null))).toEqual([]);
    });
  });
});
